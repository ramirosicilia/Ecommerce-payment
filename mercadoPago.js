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
    const { mp, ecommerce } = req.body;

    console.log('📦 mp:', mp);
    console.log('👤 ecommerce:', ecommerce);

    if (!Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: 'No hay productos en la compra.' });
    }

    for (const item of mp) {
      if (!item.id) {
        return res.status(400).json({ error: 'Algún producto no tiene id.' });
      }
    }

    const carritoFormateado = mp.map(item => ({
      producto_id: item.producto_id,
      color_id: item.color_id,
      talle_id: item.talle_id,
      cantidad: item.quantity,
      unit_price: item.unit_price
    }));

    const total = mp.reduce((acc, item) => acc + (Number(item.unit_price) * Number(item.quantity)), 0);
    console.log('💲 Total calculado:', total);

    // 🔑 Generar external_reference
    const externalReference = `${ecommerce[0].user_id}-${Date.now()}`;
    console.log('🔗 external_reference generado:', externalReference);

    const body = {
      items: mp.map(item => ({
        id: item.producto_id,
        title: item.name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price)
      })),
      metadata: {
        carrito: carritoFormateado,
        user_id: ecommerce[0].user_id,
        total
      },
      external_reference: externalReference,
      notification_url: `${process.env.URL_FRONT}/orden`,
      back_urls: {
        success: `${process.env.URL_FRONT}/compraRealizada.html`,
        failure: `${process.env.URL_FRONT}/productosUsuario.html`,
        pending: `${process.env.URL_FRONT}/productosUsuario.html`
      },
      auto_return: "approved"
    };

    console.log('📨 Enviando body a MercadoPago:', JSON.stringify(body, null, 2));

    const result = await preference.create({ body });

    console.log('✅ Preferencia creada:', result.id);

    // 🧾 Guardar en carritos_temporales con external_reference
    const { error: insertError } = await supabase.from('carritos_temporales').insert([{
      preference_id: result.id,
      external_reference: externalReference,
      user_id: ecommerce[0].user_id,
      carrito: carritoFormateado,
      total,
      fecha_creacion: new Date().toISOString()
    }]);

    if (insertError) {
      console.error("❌ Error al insertar carrito temporal:", insertError);
    } else {
      console.log("📦 Carrito temporal guardado correctamente");
    }

    // Devolver también el external_reference
    res.json({ id: result.id, external_reference: externalReference });

  } catch (error) {
    console.error("❌ Error al crear la preferencia:", error);
    res.status(500).json({ error: error.message });
  }
});


// 📩 Webhook
app.post('/orden', async (req, res) => {
  try {
    const { type, action, data } = req.body;
    const id = data?.id;

    console.log('📩 Webhook recibido en /orden:', JSON.stringify(req.body, null, 2));

    if (!id || !type || !action) {
      return res.status(400).json({ error: 'Faltan datos en el webhook.' });
    }

    if (type !== 'payment' || action !== 'payment.created') {
      console.warn(`⚠️ Webhook ignorado: type=${type}, action=${action}`);
      return res.sendStatus(200);
    }

    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

    const mpResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const pago = mpResponse.data;
    console.log('💵 Datos del pago:', JSON.stringify(pago, null, 2));

    if (pago.status !== 'approved') {
      console.log(`🔁 Pago ${id} con estado ${pago.status}, no se procesa`);
      return res.sendStatus(200);
    }

    // ✅ AHORA usamos external_reference directamente
    const preferenceId = pago.external_reference;

    console.log('🔎 preferenceId recibido en webhook:', preferenceId);

    if (!preferenceId) {
      console.error('❌ No se pudo obtener el preference_id desde el pago.');
      return res.status(400).json({ error: 'Falta preference_id' });
    }

    // ✅ Buscar carrito temporal
    const { data: carritoTemp, error: errorTemp } = await supabase
      .from('carritos_temporales')
      .select('*')
      .eq('preference_id', preferenceId)
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

    // Insertar pedido
    const { data: pedidoInsertado, error: errorPedido } = await supabase
      .from('pedidos')
      .insert([{
        usuario_id: user_id,
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
    console.log('🧾 Pedido insertado con ID:', pedido_id);

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

      console.log(`🧩 Producto registrado en detalle_pedidos: ${producto_id} (${cantidad} unidades)`);
    }

    // ✅ Limpieza
    await supabase.from('carritos_temporales')
      .delete()
      .eq('preference_id', preferenceId);

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
