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

    console.log('🔔 /create_preference recibido');
    console.log('📦 Productos mp:', mp);
    console.log('🛍️ Datos ecommerce:', ecommerce);

    if (!Array.isArray(mp) || mp.length === 0) {
      console.log('❌ No hay productos en la compra');
      return res.status(400).json({ error: 'No hay productos en la compra.' });
    }
    if (!ecommerce || !ecommerce.user_id) {
      console.log('❌ Faltan datos de ecommerce (user_id)');
      return res.status(400).json({ error: 'Faltan datos de ecommerce (user_id).' });
    }

    // Validar que todos los productos tengan id, quantity y unit_price válidos
    for (const item of mp) {
      if (!item.id || !item.quantity || !item.unit_price) {
        console.log('❌ Algún producto tiene datos incompletos:', item);
        return res.status(400).json({ error: 'Algún producto tiene datos incompletos.' });
      }
    }

    // Crear items para Mercado Pago
    const itemsMP = mp.map(item => ({
      id: item.id,
      title: item.name,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
    }));

    // Metadata carrito
    const metadataCarrito = mp.map(item => ({
      producto_id: item.id,
      cantidad: Number(item.quantity),
      unit_price: Number(item.unit_price),
      color_id: item.color_id || null,
      talle_id: item.talle_id || null,
    }));

    // Calcular total por seguridad si no viene en ecommerce.total
    const totalCalculado = metadataCarrito.reduce((acc, item) => acc + (item.cantidad * item.unit_price), 0);
    const totalFinal = ecommerce.total ? Number(ecommerce.total) : totalCalculado;

    console.log('💵 Total calculado:', totalCalculado);
    console.log('💵 Total final usado:', totalFinal);

    const body = {
      items: itemsMP,
      metadata: {
        carrito: metadataCarrito,
        user_id: ecommerce.user_id,
        total: totalFinal,
      },
      notification_url: `${process.env.URL_FRONT}/orden`,
      back_urls: {
        success: `${process.env.URL_FRONT}/compraRealizada.html`,
        failure: `${process.env.URL_FRONT}/productosUsuario.html`,
        pending: `${process.env.URL_FRONT}/productosUsuario.html`,
      },
      auto_return: "approved",
    };

    console.log('📦 Creando preferencia con cuerpo:', body);

    const result = await MercadoPago.preferences.create(body);

    console.log('✅ Preferencia creada con ID:', result.body.id);
    res.json({ id: result.body.id });

  } catch (error) {
    console.error("❌ Error al crear la preferencia:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/orden', async (req, res) => {
  try {
    console.log('🔔 POST /orden recibido');

    const { type, action, data } = req.body;
    console.log('🧾 Body recibido:', req.body);

    const id = data?.id;
    console.log('🔍 ID del pago:', id);
    console.log('🔍 Type:', type);
    console.log('🔍 Action:', action);

    if (!id || !type || !action) {
      console.log('❌ Falta id, type o action en el cuerpo');
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

    if (pago.status !== 'approved') {
      console.log(`🔁 Pago ${id} con estado ${pago.status}, no se procesa`);
      return res.sendStatus(200);
    }

    console.log('💰 Pago aprobado. Extrayendo metadata...');

    const carrito = pago.metadata?.carrito || [];
    const user_id = pago.metadata?.user_id;
    let total = pago.metadata?.total;

    console.log('🔍 Metadata recibida:', pago.metadata);

    // ✅ Fallback para total inválido o ausente
    if (!total || isNaN(Number(total))) {
      console.warn('⚠️ total no recibido o inválido desde metadata. Calculando manualmente...');
      total = carrito.reduce((acc, item) => {
        const cantidad = Number(item.cantidad ?? item.quantity ?? 1);
        const precio = Number(item.unit_price);
        return acc + (cantidad * precio);
      }, 0);
      console.log('💵 Total reconstruido:', total);
    } else {
      total = Number(total); // aseguramos tipo número
    }

    if (!carrito.length || !user_id || isNaN(total)) {
      console.error('❌ Metadata incompleta o malformada');
      return res.status(400).json({ error: 'Metadata incompleta en el pago.' });
    }

    console.log('🛒 Carrito:', carrito);
    console.log('👤 User ID:', user_id);
    console.log('💵 Total:', total);

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
    console.log(`📦 Pedido insertado con ID: ${pedido_id}`);

    for (const item of carrito) {
      const { producto_id, color_id, talle_id, cantidad, unit_price } = item;
      console.log('🔄 Procesando item del carrito:', item);

      const { data: variantes, error } = await supabase
        .from('producto_variantes')
        .select('variante_id, stock')
        .match({ producto_id, color_id, talle_id });

      if (error) {
        console.error('❌ Error consultando variantes:', error);
        continue;
      }

      if (!variantes || variantes.length === 0) {
        console.warn('⚠️ Variante no encontrada para:', item);
        continue;
      }

      const variante = variantes[0];
      const nuevoStock = variante.stock - cantidad;

      if (nuevoStock < 0) {
        console.warn('⚠️ Stock insuficiente para producto:', producto_id);
        continue;
      }

      const { error: errorUpdate } = await supabase
        .from('producto_variantes')
        .update({ stock: nuevoStock })
        .eq('variante_id', variante.variante_id);

      if (errorUpdate) {
        console.error(`❌ Error actualizando stock para variante ${variante.variante_id}:`, errorUpdate);
        continue;
      }

      const { error: errorDetalle } = await supabase
        .from('detalle_pedidos')
        .insert([{
          pedido_id,
          variante_id: variante.variante_id,
          cantidad,
          precio_unitario: unit_price
        }]);

      if (errorDetalle) {
        console.error(`❌ Error insertando detalle de pedido para variante ${variante.variante_id}:`, errorDetalle);
        continue;
      }

      console.log(`🧾 Detalle de pedido insertado para variante ${variante.variante_id}`);
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


app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
});
