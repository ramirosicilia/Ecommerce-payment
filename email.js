import nodemailer from "nodemailer"; 
import dotenv, { config } from 'dotenv';

config(); 


const transportes = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.USER_NAME,
        pass: process.env.USER_PASSWORD
    }
});

export async function validarMail(pedidoID, carritoFinal, email, total,fecha) { 
    return transportes.sendMail({
        from: process.env.USER_EMAIL,
        to: email, 
        subject: 'Hola, aqui le enviamos el detalle de su compra!!!',
        html: cuerpoMail(pedidoID, carritoFinal, email, total,fecha)
    });
}  




function cuerpoMail(pedidoID, carritoFinal, email, total, fechaCompleta) {
  const filasProductos = carritoFinal.map(item => `
    <tr>
      <td>${item.nombre}</td>
      <td>${item.talle}</td>
      <td>${item.color}</td>
      <td>${item.cantidad}</td>
      <td>$${item.precio}</td>
      <td>$${item.subtotal}</td>
    </tr>
  `).join('');

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confirmación de Pedido</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        background-color: #f4f4f4;
        margin: 0;
        padding: 0;
      }
      .email-container {
        max-width: 700px;
        margin: 30px auto;
        background-color: #fff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 10px rgba(0,0,0,0.1);
        border: 1px solid #ddd;
      }
      .email-header {
        background-color: #2a9d8f;
        color: white;
        text-align: center;
        padding: 25px;
      }
      .email-header h2 {
        margin: 0;
        font-size: 26px;
      }
      .email-body {
        padding: 25px;
        color: #333;
      }
      .email-body h3 {
        margin-top: 0;
        font-size: 20px;
        color: #333;
      }
      .pedido-info {
        margin-bottom: 20px;
        font-size: 16px;
        color: #444;
      }
      .email-body table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 15px;
      }
      .email-body th, .email-body td {
        border: 1px solid #ddd;
        padding: 10px;
        text-align: center;
      }
      .email-body th {
        background-color: #e9f5f2;
        font-weight: bold;
      }
      .total {
        text-align: right;
        margin-top: 20px;
        font-size: 18px;
        font-weight: bold;
      }
      .email-footer {
        background-color: #f9f9f9;
        text-align: center;
        padding: 15px;
        font-size: 13px;
        color: #777;
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="email-header">
        <h2>¡Gracias por tu compra!</h2>
      </div>
      <div class="email-body">
        <h3>Hola ${email},</h3>
        <div class="pedido-info">
          <p><strong>Número de pedido:</strong> #${pedidoID}</p>
          <p><strong>Fecha y hora:</strong> ${fechaCompleta}</p>
        </div>
        <p>Estos son los detalles de tu compra:</p>

        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Talle</th>
              <th>Color</th>
              <th>Cantidad</th>
              <th>Precio Unitario</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${filasProductos}
          </tbody>
        </table>

        <p class="total">Total del pedido: $${total}</p>
      </div>
      <div class="email-footer">
        &copy;Ecommerce · Todos los derechos reservados.
      </div>
    </div>
  </body>
  </html>
  `;
}
