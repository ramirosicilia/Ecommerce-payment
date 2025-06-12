import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import axios from 'axios'; // <-- Asegurate de instalar esto con: npm install axios


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
 accessToken: process.env.Access_Token, 
  options: { timeout: 40000 }
}); 

const preference = new Preference(client); 

 console.log("token",process.env.Access_Token)  

 

app.get('/', (req, res) => {
  res.send('soy el server');
});

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
      notification_url: "https://mensajeria24hs.site/orden",  // Asegurate de usar /orden
      back_urls: {
        success: "https://mensajeria24hs.site/",
        failure: "https://mensajeria24hs.site/",
        pending: "https://mensajeria24hs.site/"
      },
      auto_return: "approved"
    };

    const result = await preference.create({ body });

      res.json({ id: result.id }); // corregido aquí

  } catch (error) {
    console.error("Error al crear la preferencia:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔥 RUTA PARA RECIBIR WEBHOOK DE MERCADO PAGO
app.post('/orden', async (req, res) => {
  try {
    const { id, type } = req.body;

    console.log('📩 Webhook recibido en /orden:', req.body);

    if (!id || !type) {
      return res.status(400).json({ error: 'Falta id o type en el cuerpo del webhook.' });
    }

    // Solo procesamos si el tipo es 'payment'
    if (type !== 'payment') {
      console.warn(`⚠️ Tipo de webhook no manejado: ${type}`);
      return res.sendStatus(200); // Respondemos igual para evitar reintentos
    }

    // Consultamos a Mercado Pago el pago completo
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

    const mpResponse = await axios.get(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const pago = mpResponse.data;

    console.log('✅ Detalles del pago recibido:', pago);

    // Acá podés guardar en DB, enviar correo, actualizar stock, etc.
    // Por ahora solo devolvemos OK
    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Error al procesar webhook /orden:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`Estoy escuchando el puerto ${port}`);
});
