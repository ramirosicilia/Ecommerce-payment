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

 console.log("token",process.env.MERCADO_PAGO_ACCESS_TOKEN)  

 


app.get('/', (req, res) => {
  res.send('soy el server');
});

// 🧾 Crear preferencia de pago
app.post('/create_preference', async (req, res) => {
  try {
    const { mp, ecommerce } = req.body;

    if (!Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: 'No hay productos en la compra.' });
    }

    for (const item of mp) {
      if (!item.id) {
        return res.status(400).json({ error: 'Algún producto no tiene id.' });
      }
    }

    const total = mp.reduce((acc, item) => acc + item.quantity * item.unit_price, 0);
    const external_reference = `carrito-${ecommerce[0].user_id}-${Date.now()}`;

    // Guardar carrito temporalmente en Supabase
    const { error: errorCarrito } = await supabase
      .from('carritos_temporales')
      .insert([{
        external_reference,
        user_id: ecommerce[0].user_id,
        carrito: mp,
        total
      }]);

    if (errorCarrito) {
      console.error('❌ Error al guardar carrito temporal:', errorCarrito);
      return res.status(500).json({ error: 'Error al guardar el carrito' });
    }

    const body = {
      items: mp.map(item => ({
        id: item.producto_id,
        title: item.name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price)
      })),
      external_reference,
      notification_url: `${process.env.URL_FRONT}/orden`,
      back_urls: {
        success: `${process.env.URL_FRONT}/compraRealizada.html`,
        failure: `${process.env.URL_FRONT}/productosUsuario.html`,
        pending: `${process.env.URL_FRONT}/productosUsuario.html`
      },
      auto_return: "approved"
    };

    const result = await preference.create({ body });

    res.json({ id: result.id });

  } catch (error) {
    console.error("Error al crear la preferencia:", error);
    res.status(500).json({ error: error.message });
  }
});


app.post('/orden', async (req, res) => {
  try {
    const { type, action, data } = req.body;
    const id = data?.id;

    console.log('📩 Webhook recibido en /orden:', req.body);

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

    if (!pago.external_reference) {
      console.warn('⚠️ No hay external_reference, no se puede continuar.');
      return res.sendStatus(200);
    }

    if (pago.status !== 'approved') {
      console.log(`🔁 Pago ${id} con estado ${pago.status}, no se procesa`);
      return res.sendStatus(200);
    }

    const { data: carritoTemporal, error: errorBuscar } = await supabase
      .from('carritos_temporales')
      .select('*')
      .eq('external_reference', pago.external_reference)
      .single();

    if (errorBuscar || !carritoTemporal) {
      console.error('❌ No se encontró el carrito temporal:', errorBuscar);
      return res.sendStatus(200);
    }

    const carrito = carritoTemporal.carrito;
    const user_id = carritoTemporal.user_id;
    const total = carritoTemporal.total;

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

    for (const item of carrito) {
      const { producto_id, color_id, talle_id, quantity, unit_price } = item;

      const { data: variantes, error } = await supabase
        .from('producto_variantes')
        .select('variante_id, stock')
        .match({ producto_id, color_id, talle_id });

      if (error || !variantes || variantes.length === 0) {
        console.error('❌ Variante no encontrada para:', item);
        continue;
      }

      const variante = variantes[0];
      const nuevoStock = variante.stock - quantity;

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
        cantidad: quantity,
        precio_unitario: unit_price
      }]);
    }

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