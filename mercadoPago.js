import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import axios from 'axios'; // <-- Asegurate de instalar esto con: npm install axios
import { supabase } from './DB.js';
import { v4 as uuidv4 } from 'uuid';
import { validarMail } from './email.js';



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

const token=process.env.MERCADO_PAGO_ACCESS_TOKEN

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
      color_nombre: item.color_nombre,
      talle_nombre: item.talle_nombre,
      cantidad: item.quantity,
      unit_price: item.unit_price,
       currency_id: "ARS",
    }));

    const total = mp.reduce(
      (acc, item) => acc + (Number(item.unit_price) * Number(item.quantity)),
      0
    ); 
    // ✅ Generar un external_reference único
     const externalReference = uuidv4();


    const preferenceBody = {
      external_reference: externalReference, //
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
      auto_return:"approved"
    };

    const result = await preference.create({ body: preferenceBody }); 
    console.log("📦 Resultado completo de preference.create:", JSON.stringify(result, null, 2));


    const preferenceId = result.id; 
    console.log('📤 Enviando a Mercado Pago:', JSON.stringify(preferenceBody, null, 2));


    console.log("🟢 preferenceId:", preferenceId);
  
    console.log("🟢 carritoFormateado:", carritoFormateado);
    console.log("🟢 total:", total);

   
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

    const { status, id: payment_id, transaction_amount, external_reference, metadata } = pago;

const { error: pagoInsertError } = await supabase
  .from('pagos')
  .insert([{
    pago_id: uuidv4(), // porque es UUID
    payment_id: Number(payment_id), // bigint
    status, // string
    preference_id: external_reference || null, // string
    transaction_amount: Number(transaction_amount), // number
    usuario_id: metadata?.user_id || null, // string (UUID)
  }]);

if (pagoInsertError) {
  console.error('❌ Error al registrar el pago en la tabla pagos:', pagoInsertError);
}


    console.log('aca esta el pago ',pago)

    // Nueva validación: solo seguimos si el pago está aprobado
    if (pago.status !== 'approved') {
      console.warn('⛔️ Pago no aprobado, no se procesa carrito ni pedido');
      return res.sendStatus(200);
    }
   
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

    // Insertar carrito temporal en el webhook (solo si pago aprobado)
    const carrito = pago.metadata?.carrito;
    const userId = pago.metadata?.user_id;
    const total = pago.metadata?.total;

    if (!carrito || !userId || !total) {
      console.error("❌ Metadata incompleta en el pago");
      return res.status(400).json({ error: 'Metadata incompleta en el pago' });
    }

    const { error: insertCarritoError } = await supabase.from('carritos_temporales').insert([{
    

      external_reference: externalReference,
      carrito,
      user_id: userId,
      total,
      fecha_creacion: new Date().toISOString()
    }]);

    if (insertCarritoError) {
      console.error('❌ Error al insertar carrito temporal:', insertCarritoError);
      return res.status(500).json({ error: 'Error al guardar carrito temporal', detalle: insertCarritoError.message });
    }

    // Buscar carrito temporal recién insertado para continuar con pedido
    const { data: carritoTemp, error: errorTemp } = await supabase
      .from('carritos_temporales')
      .select('*')
      .eq('external_reference', externalReference)
      .limit(1)
      .maybeSingle();

    if (errorTemp || !carritoTemp) {
      console.error('❌ No se encontró carrito temporal:', errorTemp);
      return res.status(500).json({ error: 'No se pudo recuperar el carrito' });
    }

    // --- resto del código igual ---
    const carritoDb = carritoTemp.carrito;
    const totalDb = carritoTemp.total;
    const userIdDb = carritoTemp.user_id;

    console.log('💰 total:', totalDb);
    console.log('🛒 carrito:', carritoDb);
    console.log("external referenceeee", externalReference) 

    
    await supabase
      .from('pedidos')
      .delete()
      .eq('preference_id', externalReference);

    const { data: pedidoInsertado, error: errorPedido } = await supabase
      .from('pedidos')
      .insert([{
        usuario_id: userIdDb,
        total: totalDb,
        estado: 'pagado',
        preference_id: externalReference,
        fecha_creacion: new Date().toISOString(),
      }])
      .select('pedido_id')
      .single();

    if (errorPedido || !pedidoInsertado ) {
      console.error('❌ Error al insertar el pedido:', errorPedido);
      return res.status(500).json({ error: 'No se pudo insertar el pedido' });
    }

    const pedido_id = pedidoInsertado.pedido_id;
    let productsID=null

    for (const item of carritoDb) {
      const { producto_id, color_nombre, talle_nombre, cantidad, unit_price } = item;
      console.log(producto_id, "producto_id");
      console.log(color_nombre, "color_nombre");
      console.log(talle_nombre, "talle_nombre");
      console.log(cantidad, "cantidad");
      console.log(unit_price,"precio");
     

    const { data: productosConVariantes, error: errorProducto } = await supabase
  .from('productos')
  .select(`
    producto_id,
    productos_variantes (  variante_id, stock, colores (insertar_color),talles ( insertar_talle ))
  `)
  .eq('producto_id', producto_id)
  .maybeSingle();

      if (errorProducto || !productosConVariantes) {
        console.error('❌ Error al obtener producto con variantes:', errorProducto);
        continue;
      }

      // 📦 Unir todas las variantes del producto
      const todasLasVariantes = productosConVariantes.productos_variantes; 

      if (!Array.isArray(todasLasVariantes)) {
        console.error("⚠️ productos_variantes no es un array:", todasLasVariantes);
        continue;
      }

          // 🧠 Buscar variante correcta por color_id y talle_id
          const variante = todasLasVariantes.find(v =>
        (!color_nombre || v.colores?.insertar_color?.trim().toLowerCase() === color_nombre.trim().toLowerCase()) &&
        (!talle_nombre || v.talles?.insertar_talle?.trim().toLowerCase() === talle_nombre.trim().toLowerCase())
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
        producto_id,
        precio_unitario: unit_price
      }]); 

        productsID=producto_id
    } 
    
 
    console.log(externalReference)
   

    console.log(`✅ Pedido ${pedido_id} registrado correctamente.`);

      await obtencionDataEmail(pedido_id,carritoDb,total,userId)
     
    return res.sendStatus(200);

  } catch (error) {
    console.error('❌ Error al procesar webhook /orden:');
    console.error('Mensaje:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: 'Error interno', detalle: error.message });
  }
}); 

 app.get("/token-mercadopago",(req,res)=>{ 

  //CUANDO SON ENPOINT SIMPLES CON POCO CONTENIDO Y DATOS POR COMODIDAD NO USO TRY CATCH PERO QUEDA EN CRITERIO DE CADA UNO

  if(!token){ 

    res.json({error:"falta el token"})

  } 

    res.json(token)
 
 }) 

 app.get("/pagos-mercadopago",async(req,res)=>{ 


  const pagosMP= await supabase.from("pagos").select("*")

   //CUANDO SON ENPOINT SIMPLES CON POCO CONTENIDO Y DATOS POR COMODIDAD NO USO TRY CATCH PERO QUEDA EN CRITERIO DE CADA UNO
  
/*let { data: pagos} = await supabase
  .from('pagos')
  .select('*') */

  if(pagosMP.data.length===0){ 
    res.json({error:'no se pudieron obtener los pagos'})

  } 
  res.json(pagosMP.data)
          

 }) 
 



 app.get("/pedidos",async(req,res)=>{ 


  const pedidos= await supabase.from("pedidos").select("*")

   //CUANDO SON ENPOINT SIMPLES CON POCO CONTENIDO Y DATOS POR COMODIDAD NO USO TRY CATCH PERO QUEDA EN CRITERIO DE CADA UNO
 

  if(pedidos.data.length===0){ 
    res.json({error:'no se pudieron obtener los pagos'})

  } 
  res.json(pedidos.data)
          

 }) 

 app.get("/detalles-productos",async(req,res)=>{ 


  const detalles= await supabase.from("detalle_pedidos").select("*")

   //CUANDO SON ENPOINT SIMPLES CON POCO CONTENIDO Y DATOS POR COMODIDAD NO USO TRY CATCH PERO QUEDA EN CRITERIO DE CADA UNO
 

  if(detalles.data.length===0){ 
    res.json({error:'no se pudieron obtener los pagos'})

  } 
  res.json(detalles.data)
          

 }) 


 async function obtencionDataEmail(pedidoID, carrito, total, userId) {
  // 1. Obtener email del usuario
  const { data: emailData, error: errorEmail } = await supabase
    .from("usuarios")
    .select('email')
    .eq('usuario_id', userId)
    .single();

  if (errorEmail) {
    console.error("Error al obtener email:", errorEmail);
    return;
  }

  // 2. Obtener nombre del producto para cada item del carrito
  const carritoMapeado = await Promise.all(
    carrito.map(async (item) => {
      const { data: productoData, error: errorProducto } = await supabase
        .from("productos")
        .select("nombre_producto")
        .eq("producto_id", item.producto_id)
        .single();

      if (errorProducto) {
        console.error(`Error al obtener producto ${item.producto_id}:`, errorProducto);
        return null;
      }

      return {
        nombre: productoData.nombre_producto,
        talle: item.talle_nombre,
        color: item.color_nombre,
        cantidad: item.cantidad,
        precio: item.unit_price,
        subtotal: item.unit_price * item.cantidad
      };
    }) 
  ); 


  // Filtrar cualquier item nulo por error de consulta
  const carritoFinal = carritoMapeado.filter(item => item !== null); 
  const { data: fechaData, error: errorFecha } = await supabase
  .from("pedidos")
  .select("fecha_creacion")
  .eq("pedido_id", pedidoID)
  .single();

if (errorFecha) {
  console.error("Error al obtener fecha del pedido:", errorFecha);
  return;
}

// 3.2 Formatear fecha a formato argentino
const fechaOriginal = new Date(fechaData.fecha_creacion);
const fechaFormateada = fechaOriginal.toLocaleDateString('es-AR');  // ej: 03/11/2025
const horaFormateada = fechaOriginal.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); // ej: 14:35
const fechaCompleta = `${fechaFormateada} - ${horaFormateada}`;

  // 3. Llamar a función final
  await validarMail(pedidoID, carritoFinal, emailData.email, total,fechaCompleta);
}




// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`Estoy escuchando el puerto ${port}`);
});
