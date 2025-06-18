import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import axios from 'axios'; // <-- Asegurate de instalar esto con: npm install axios
import { supabase } from './DB.js';
import { randomUUID } from 'crypto';



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
  res.send('Soy el servidor funcionando');
});

// 🔁 CREAR PREFERENCIA
app.post('/create_preference', async (req, res) => {
  try {
    const { mp, ecommerce } = req.body;

    if (!Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: 'No hay productos en la compra.' });
    }

    const carritoFormateado = mp.map(item => ({
      producto_id: item.producto_id,
      color_id: item.color_id,
      talle_id: item.talle_id,
      cantidad: item.quantity,
      unit_price: item.unit_price
    }));

    const total = mp.reduce((acc, item) => acc + (Number(item.unit_price) * Number(item.quantity)), 0);
    const user_id = ecommerce[0].user_id;
   const preference_id = randomUUID();


    const body = {
      items: mp.map(item => ({
        id: item.producto_id,
        title: item.name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price)
      })),
      back_urls: {
        success: `${process.env.URL_FRONT}/compraRealizada.html`,
        failure: `${process.env.URL_FRONT}/productosUsuario.html`,
        pending: `${process.env.URL_FRONT}/productosUsuario.html`
      },
      notification_url: `${process.env.URL_BACK}/orden`,
      auto_return: "approved",
      metadata: {
        carrito: carritoFormateado,
        user_id,
        total,
        preference_id // 👈 queda en el pago
      },
      external_reference: preference_id // 👈 respaldo por si MercadoPago no devuelve metadata
    };

    const result = await preference.create({ body });

    // 📝 Guardar carrito temporal
    await supabase.from('carritos_temporales').insert([{
      preference_id,
      user_id,
      carrito: carritoFormateado,
      total,
      fecha_creacion: new Date().toISOString()
    }]);

    console.log('🆗 Preferencia creada con ID MercadoPago:', result.id);
    console.log('🔐 Preference ID interno (UUID):', preference_id);

    res.json({ id: result.id });

  } catch (error) {
    console.error("❌ Error al crear preferencia:", error);
    res.status(500).json({ error: error.message });
  }
});

// 📩 WEBHOOK
app.post('/orden', async (req, res) => {
  try {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

    const { type, action, data } = req.body;
    const id = data?.id;

    if (!id || type !== 'payment' || action !== 'payment.created') {
      console.warn('⚠️ Webhook ignorado por datos incorrectos.');
      return res.sendStatus(200);
    }

    const mpResponse = await axios.get(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: {
        Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`
      }
    });

    const pago = mpResponse.data;

    if (pago.status !== 'approved') {
      console.log('⏳ Pago no aprobado, se ignora:', pago.status);
      return res.sendStatus(200);
    }

    // ✅ Fallback a external_reference si no vino en metadata
    const preferenceId = pago.metadata?.preference_id || pago.external_reference;

    if (!preferenceId) {
      console.error('❌ No se pudo obtener preference_id ni desde metadata ni desde external_reference.');
      return res.status(400).json({ error: 'Falta preference_id.' });
    }

    const { data: carritoTemp, error: errorTemp } = await supabase
      .from('carritos_temporales')
      .select('*')
      .eq('preference_id', preferenceId)
      .single();

    if (errorTemp || !carritoTemp) {
      console.error('❌ No se encontró carrito temporal:', errorTemp);
      return res.status(500).json({ error: 'Carrito temporal no encontrado.' });
    }

    const { carrito, user_id, total } = carritoTemp;

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
      console.error('❌ Error al insertar pedido:', errorPedido);
      return res.status(500).json({ error: 'No se pudo insertar el pedido.' });
    }

    const pedido_id = pedidoInsertado.pedido_id;

    for (const item of carrito) {
      const { producto_id, color_id, talle_id, cantidad, unit_price } = item;

      const { data: variantes, error } = await supabase
        .from('producto_variantes')
        .select('variante_id, stock')
        .match({ producto_id, color_id, talle_id });

      if (error || !variantes || variantes.length === 0) {
        console.warn('⚠️ Variante no encontrada para:', item);
        continue;
      }

      const variante = variantes[0];
      const nuevoStock = variante.stock - cantidad;

      if (nuevoStock < 0) {
        console.warn('⚠️ Stock insuficiente para producto:', producto_id);
        continue;
      }

      await supabase
        .from('producto_variantes')
        .update({ stock: nuevoStock })
        .eq('variante_id', variante.variante_id);

      await supabase
        .from('detalle_pedidos')
        .insert([{
          pedido_id,
          variante_id: variante.variante_id,
          cantidad,
          precio_unitario: unit_price
        }]);
    }

    await supabase
      .from('carritos_temporales')
      .delete()
      .eq('preference_id', preferenceId);

    console.log(`✅ Pedido ${pedido_id} registrado correctamente.`);
    return res.sendStatus(200);

  } catch (error) {
    console.error('❌ Error procesando /orden');
    console.error('Mensaje:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});



app.listen(port, () => {
  console.log(`Servidor escuchando en puerto ${port}`);
});