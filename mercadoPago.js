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
 
     const body = {
       items: mp.map(item => ({
         id: item.producto_id,
         title: item.name,
         quantity: Number(item.quantity),
         unit_price: Number(item.unit_price)
       })),
      metadata: {
     carrito: mp.map(item => ({
       producto_id: item.producto_id,
       color_id: item.color_id,
       talle_id: item.talle_id,
       cantidad: item.quantity,
       unit_price: item.unit_price  // 🟢 AGREGALO AQUÍ
     })),
     user_id: ecommerce.user_id,
     total: ecommerce.total
   },
       notification_url: `${process.env.URL_FRONT}/orden`,
      back_urls: {
        success: `${process.env.URL_FRONT}/compraRealizada.html`,
        failure: `${process.env.URL_FRONT}/productosUsuario.html`,
        pending: `${process.env.URL_FRONT}/productosUsuario.html`,
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

// 🔔 Webhook de MercadoPago
app.post('/orden', async (req, res) => {
  try {
    const { type, data } = req.body;
    const id = data?.id;

    console.log('📩 Webhook recibido en /orden:', req.body);

    if (!id || !type) {
      return res.status(400).json({ error: 'Falta id o type en el cuerpo del webhook.' });
    }

    if (type !== 'payment') {
      console.warn(`⚠️ Tipo de webhook no manejado: ${type}`);
      return res.sendStatus(200);
    }

    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

    const mpResponse = await axios.get(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const pago = mpResponse.data;

   if (pago.status === 'approved') {
  const carrito = pago.metadata.carrito;
  const user_id = pago.metadata.user_id;
  const total = pago.metadata.total;

  // Insertar pedido y obtener el UUID generado automáticamente
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

  const pedido_id = pedidoInsertado.pedido_id; // 🟢 UUID generado por Supabase

  for (const item of carrito) {
    const { producto_id, color_id, talle_id, cantidad, unit_price } = item;

    const { data: variantes, error } = await supabase
      .from('producto_variantes')
      .select('variante_id, stock')
      .match({ producto_id, color_id, talle_id });

    if (error || !variantes || variantes.length === 0) {
      console.error('No se encontró variante para:', item);
      continue;
    }

    const variante = variantes[0];
    const nuevoStock = variante.stock - cantidad;

    if (nuevoStock < 0) {
      console.warn('⚠️ Stock insuficiente para', producto_id);
      continue;
    }

    // Actualizar stock
    await supabase
      .from('producto_variantes')
      .update({ stock: nuevoStock })
      .eq('variante_id', variante.variante_id);

    // Insertar en detalle_pedidos
    await supabase.from('detalle_pedidos').insert([{
      pedido_id: pedido_id,
      variante_id: variante.variante_id,
      cantidad: cantidad,
      precio_unitario: unit_price
    }]);
  }

  console.log(`✅ Pedido ${pedido_id} registrado con éxito.`);
}

res.sendStatus(200);


  } catch (error) {
    console.error('❌ Error al procesar webhook /orden:');
    console.error('Mensaje:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Error interno', detalle: error.message });
  }
});

// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`Estoy escuchando el puerto ${port}`);
});