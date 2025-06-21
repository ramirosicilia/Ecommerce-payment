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
      notification_url:`${process.env.URL_PAYMENTS}/orden`,
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
  
    console.log("🟢 carritoFormateado:", carritoFormateado);
    console.log("🟢 total:", total);

    // Validar UUID
        await supabase
      .from('carritos_temporales')
      .delete()
      .eq('external_reference', userId);

   

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

app.get('/orden', (req, res) => {
  res.status(405).send('Método no permitido. Este endpoint es solo para POST de MercadoPago.');
});


// 📩 Webhook
app.post('/orden', async (req, res) => {

  try {
    const { type, action, data } = req.body;
    const id = data?.id;



    console.log('📩 Webhook recibido en /orden:', req.body);

    console.log(type+" "+ data + " " +action+" "+"la info")

    if (!id || !type || !action) {
      return res.status(400).json({ error: 'Faltan datos en el webhook.' });
    }

    if (type !=='payment' || action !=='payment.created') {
      console.warn(`⚠️ Webhook ignorado: type=${type}, action=${action}`);
      return res.sendStatus(200);
    }  

    console.log("el iddd",id)

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

    console.log('aca esta el pago ',pago)

   
    // 🔎 Obtener external_reference desde pago o desde la orden
    let externalReference = pago.external_reference;
    console.log('decime si lo devuelve',externalReference)

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

    // 🧾 Buscar el carrito temporal por external_reference (NO preference_id)
         const { data: carritoTemp, error: errorTemp } = await supabase
         .from('carritos_temporales')
         .select('*')
         .eq('external_reference', externalReference)
         .limit(1)
         .maybeSingle(); // ✅ más seguro que single()

    if (errorTemp || !carritoTemp) {
      console.error('❌ No se encontró carrito temporal:', errorTemp);
      return res.status(500).json({ error: 'No se pudo recuperar el carrito' });
    }

    // --- resto del código igual ---
    const carrito = carritoTemp.carrito;
    const total = carritoTemp.total;

    console.log('💰 total:', total);
    console.log('🛒 carrito:', carrito);
    console.log("external referenceeee", externalReference) 

    

    // Verificamos si ya existe un pedido con ese externalReference
      const { data: pedidoExistente, error: errorExistente } = await supabase
        .from('pedidos')
        .select('pedido_id')
        .eq('usuario_id', externalReference)
        .maybeSingle();

      if (pedidoExistente) {
        console.log('📦 Pedido ya existe con ese externalReference:', pedidoExistente);
        return res.status(200).json({ mensaje: 'El pedido ya fue registrado', pedido_id: pedidoExistente.pedido_id });
      }


    const { data: pedidoInsertado, error: errorPedido } = await supabase
      .from('pedidos')
      .insert([{
        usuario_id:externalReference,
        total,
        estado: 'pagado',
        fecha_creacion: new Date().toISOString(),
        fecha_actualizacion: new Date().toISOString()
      }])
      .select('pedido_id')
      .single();

    if (errorPedido || !pedidoInsertado ) {
      console.error('❌ Error al insertar el pedido:', errorPedido);
      return res.status(500).json({ error: 'No se pudo insertar el pedido' });
    }

    const pedido_id = pedidoInsertado.pedido_id;

    for (const item of carrito) {
  const { producto_id, color_id, talle_id, cantidad, unit_price } = item;
  console.log(producto_id, "producto_id");
  console.log(color_id, "color_id");
  console.log(talle_id, "talle_id");
  console.log(cantidad, "cantidad");
  console.log(unit_price, "precio");

  // 🔍 Obtener producto con todas sus variantes
  const { data: productosConVariantes, error: errorProducto } = await supabase
    .from('productos')
    .select('producto_id, productos_variantes (variante_id, stock, color_id, talle_id)')
    .eq('producto_id', producto_id)
    .maybeSingle();

  if (errorProducto || !productosConVariantes) {
    console.error('❌ Error al obtener producto con variantes:', errorProducto);
    continue;
  }

    // 📦 Unir todas las variantes del producto
    const todasLasVariantes = productosConVariantes.productos_variantes;
  
    // 🧠 Buscar variante correcta por color_id y talle_id
    const variante = todasLasVariantes.find(
      v => v.color_id.toString().trim() === color_id.toString().trim()  && v.talle_id.toString().trim()  === talle_id.toString().trim() 
    );
  
    if (!variante) {
      console.warn('⚠️ No se encontró variante para:', item);
      continue;
    }
  
    const nuevoStock = variante.stock - cantidad;
  
    if (nuevoStock < 0) {
      console.warn('⚠️ Stock insuficiente para producto', producto_id);
      continue;
    }
  
    // 📉 Actualizar stock
    const { error: errorUpdate } = await supabase
      .from('productos_variantes')
      .update({ stock: nuevoStock })
      .eq('variante_id', variante.variante_id);
  
    if (errorUpdate) {
      console.error('❌ Error al actualizar stock:', errorUpdate);
      continue;
    }
  
    // 🧾 Insertar en detalle_pedidos
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
      .eq('external_reference', externalReference);  // también cambio aquí

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
