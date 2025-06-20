import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import axios from 'axios'; // <-- Asegurate de instalar esto con: npm install axios
import { supabase } from './DB.js';


const app = express();  



dotenv.config();
console.log(dotenv) 



const port = process.env.PORT; // Asegúrate que el frontend apunte al puerto correcto

app.use(morgan('short'));

app.use(cors({
  origin: [
     process.env.URL_FRONT
    
  ]
}));

app.use(express.json());

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  options: { timeout: 40000 }
});

const preference = new Preference(client);

console.log("token", process.env.MERCADO_PAGO_ACCESS_TOKEN);

app.get('/', (req, res) => {
  res.send('soy el server');
});

// 🧾 Crear preferencia de pago
app.post('/create_preference', async (req, res) => {
  try {
    const { mp } = req.body;

    if (!Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: 'No hay productos en la compra.' });
    }

    for (const item of mp) {
      if (!item.id) {
        return res.status(400).json({ error: 'Algún producto no tiene id.' });
      }
    }

    // ✅ Obtener user_id del primer item
    const userId = mp[0]?.user_id; 

    console.log('USER-ID',userId)

    if (!userId) {
      return res.status(400).json({ error: 'user_id no proporcionado' });
    }

    const carritoFormateado = mp.map(item => ({
      producto_id: item.producto_id,
      color_id: item.color_id,
      talle_id: item.talle_id,
      cantidad: item.quantity,
      unit_price: item.unit_price,
       currency_id: "ARS",
    }));

    const total = mp.reduce(
      (acc, item) => acc + (Number(item.unit_price) * Number(item.quantity)),
      0
    );

    const preferenceBody = {
      external_reference: userId, //
      items: mp.map(item => ({
        id: item.producto_id,
        title: item.name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price)

      })),
    
      metadata: {
        carrito: carritoFormateado,
        user_id: userId,
        total
      },
      notification_url: `${process.env.URL_FRONT}/orden`,
      back_urls: {
        success: `${process.env.URL_FRONT}/compraRealizada.html`,
        failure: `${process.env.URL_FRONT}/productosUsuario.html`,
        pending: `${process.env.URL_FRONT}/productosUsuario.html`
      },
      auto_return: "approved"
    };

    const result = await preference.create({ body: preferenceBody }); 
    console.log("📦 Resultado completo de preference.create:", JSON.stringify(result, null, 2));


    const preferenceId = result.id; 
    console.log('📤 Enviando a Mercado Pago:', JSON.stringify(preferenceBody, null, 2));


    console.log("🟢 preferenceId:", preferenceId);
    console.log("🟢 user_id:", userId);
    console.log("🟢 carritoFormateado:", carritoFormateado);
    console.log("🟢 total:", total);

    // Validar UUID
   

    const { error: insertError } = await supabase.from('carritos_temporales').insert([{
      preference_id: preferenceId,
       external_reference: userId, // ✅ AGREGA ESTO
      carrito: carritoFormateado,
      total,
      fecha_creacion: new Date().toISOString()
    }]);

    if (insertError) {
      console.error("❌ Error al insertar carrito temporal:", insertError);
      return res.status(500).json({ error: 'Error al guardar carrito temporal', detalle: insertError.message });
    }

    console.log("✅ Carrito temporal guardado correctamente con preference_id:", preferenceId);
    res.json({ id: preferenceId });

  } catch (error) {
    console.error("❌ Error inesperado al crear la preferencia:", error.message);
    return res.status(500).json({ error: 'Error interno', detalle: error.message });
  }
});


// 📩 Webhook
// 📩 Webhook
app.post('/orden', async (req, res) => {
  try {
    const { type, action, data } = req.body;
    console.log('📩 Webhook recibido en /orden:', req.body);

    let paymentId = null;
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

    if (type === 'payment' && action === 'payment.created') {
      paymentId = data?.id;
    } else if (type === 'topic_merchant_order_wh') {
      const merchantOrderId = data?.id;
      if (!merchantOrderId) {
        console.warn('❌ Webhook de orden sin ID de orden.');
        return res.status(400).json({ error: 'Falta merchant_order_id' });
      }

      const ordenResponse = await axios.get(
        `https://api.mercadopago.com/merchant_orders/${merchantOrderId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      const pagos = ordenResponse.data.payments;
      const pagoAprobado = pagos.find(p => p.status === 'approved');

      if (!pagoAprobado) {
        console.warn(`🔁 Orden ${merchantOrderId} sin pagos aprobados`);
        return res.sendStatus(200);
      }

      paymentId = pagoAprobado.id;
    } else {
      console.warn(`⚠️ Webhook ignorado: type=${type}, action=${action}`);
      return res.sendStatus(200);
    }

    console.log("💳 ID del pago:", paymentId);

    const mpResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const pago = mpResponse.data;
    console.log('💵 Detalles del pago:', pago);

    if (pago.status !== 'approved') {
      console.log(`🔁 Pago ${paymentId} con estado ${pago.status}, no se procesa`);
      return res.sendStatus(200);
    }

    // 🔎 Obtener external_reference
    let externalReference = pago.external_reference;
    if (!externalReference && pago.order?.id) {
      const ordenResponse = await axios.get(
        `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );
      externalReference = ordenResponse.data?.external_reference;
    }

    if (!externalReference) {
      console.error('❌ No se pudo obtener el external_reference desde el pago.');
      return res.status(400).json({ error: 'Falta external_reference' });
    }

    const { data: carritoTemp, error: errorTemp } = await supabase
      .from('carritos_temporales')
      .select('*')
      .eq('external_reference', externalReference)
      .single();

    if (errorTemp || !carritoTemp) {
      console.error('❌ No se encontró carrito temporal:', errorTemp);
      return res.status(500).json({ error: 'No se pudo recuperar el carrito' });
    }

    const carrito = carritoTemp.carrito;
    const user_id = carritoTemp.user_id;
    const total = carritoTemp.total;

    console.log('💰 total:', total);
    console.log('🛒 carrito:', carrito);
    console.log("👤 usuario:", user_id);
    console.log("🔗 external_reference:", externalReference);

    const { data: pedidoInsertado, error: errorPedido } = await supabase
      .from('pedidos')
      .insert([{
        usuario_id: externalReference,
        total,
        estado: 'pagado',
        fecha_creacion: new Date().toISOString(),
        fecha_actualizacion: new Date().toISOString()
      }])
      .select('pedido_id')
      .single();

    if (errorPedido || !pedidoInsertado) {
      console.error('❌ Error al insertar el pedido:', errorPedido);
      return res.status(500).json({ error: 'No se pudo insertar el pedido' });
    }

    const pedido_id = pedidoInsertado.pedido_id;

    for (const item of carrito) {
      const { producto_id, color_id, talle_id, cantidad, unit_price } = item;

      const { data: variantes, error } = await supabase
        .from('producto_variantes')
        .select('variante_id, stock')
        .match({ producto_id, color_id, talle_id });

      if (error || !variantes || variantes.length === 0) {
        console.error('❌ Variante no encontrada para:', item);
        continue;
      }

      const variante = variantes[0];
      const nuevoStock = variante.stock - cantidad;

      if (nuevoStock < 0) {
        console.warn('⚠️ Stock insuficiente para producto', producto_id);
        continue;
      }

      await supabase
        .from('producto_variantes')
        .update({ stock: nuevoStock })
        .eq('variante_id', variante.variante_id);

      await supabase.from('detalle_pedidos').insert([{
        pedido_id,
        variante_id: variante.variante_id,
        cantidad,
        precio_unitario: unit_price
      }]);
    }

    await supabase
      .from('carritos_temporales')
      .delete()
      .eq('external_reference', externalReference);

    console.log(`✅ Pedido ${pedido_id} registrado correctamente.`);
    return res.sendStatus(200);

  } catch (error) {
    console.error('❌ Error al procesar webhook /orden:');
    console.error('Mensaje:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: 'Error interno', detalle: error.message });
  }
});



// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`Estoy escuchando el puerto ${port}`);
});
