require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { google } = require("googleapis");
const fs = require("fs");

const client = new Client({
  authStrategy: new LocalAuth(),
});

// Configurar Google Sheets API usando variables de entorno
async function authorize() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: process.env.TYPE,
        project_id: process.env.PROJECT_ID,
        private_key_id: process.env.PRIVATE_KEY_ID,
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"), // Asegúrate de reemplazar los caracteres de nueva línea
        client_email: process.env.CLIENT_EMAIL,
        client_id: process.env.CLIENT_ID,
        auth_uri: process.env.AUTH_URI,
        token_uri: process.env.TOKEN_URI,
        auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_X509_CERT_URL,
        client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
        universe_domain: process.env.UNIVERSE_DOMAIN,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const authClient = await auth.getClient();
    google.options({ auth: authClient });
    return authClient;
  } catch (error) {
    console.error("Error en la autorización:", error);
    throw error;
  }
}

// ID de tu Google Sheet y rango del menú
const spreadsheetId = "1XpJUNm5Su7I9q0KlTA3Gjcj9x-2Lgiyo44WkKezt5oo"; // Reemplaza con tu ID de la hoja de cálculo
const menuRange = "productos!A1:D51"; // Reemplaza con el rango correcto

async function getMenuFromSheet(auth) {
  try {
    console.log("Iniciando obtención del menú...");
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: menuRange,
    });
    console.log("Datos obtenidos de Google Sheets:", res.data);
    const rows = res.data.values;
    if (!rows || rows.length === 0) {
      console.log("No se encontraron datos en la hoja.");
      return {};
    }
    const menuCategories = {};
    rows.forEach((row, index) => {
      if (index === 0) return; // Salta el encabezado
      const [category, name, price, description] = row;
      if (!menuCategories[category]) {
        menuCategories[category] = [];
      }
      menuCategories[category].push({ name, price, description });
    });
    console.log("Menú procesado:", menuCategories);
    return menuCategories;
  } catch (error) {
    console.error("Error al obtener el menú:", error);
    return {}; // Devuelve un objeto vacío en caso de error
  }
}

// Guardar el pedido en la hoja 'pedidos'
async function saveOrder(auth, orderData) {
  const sheets = google.sheets({ version: "v4", auth });
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "pedidos!A1",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [orderData],
      },
    });
    console.log("Pedido guardado exitosamente:", orderData);
  } catch (error) {
    console.error("Error guardando el pedido:", error);
  }
}

// Verificar si está dentro de las horas de operación
function isWithinOperatingHours() {
  const now = new Date(); // Esto usará la zona horaria del servidor Render
  const dayOfWeek = now.getUTCDay(); // Obtener el día de la semana en UTC
  const hour = now.getUTCHours() - 5; // Ajustar a la hora de Ecuador (UTC -5)

  if (dayOfWeek >= 1 && dayOfWeek <= 6) {
    // Lunes a sábado
    return hour >= 11 && hour < 22; // 11 AM a 10 PM
  } else if (dayOfWeek === 0) {
    // Domingo
    return hour >= 13 && hour < 22; // 1 PM a 10 PM
  }
  return false;
}

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("Client is ready!");
  try {
    const auth = await authorize();
    client.auth = auth; // Guardar la autenticación para su reutilización
  } catch (error) {
    console.error("Error al inicializar el cliente:", error);
  }
});

const userStates = {};

client.on("message", async (message) => {
  console.log("Mensaje recibido:", message.body);
  const userId = message.from;

  if (!userStates[userId]) {
    userStates[userId] = { step: 0, total: 0, orders: [] };
  }

  const userState = userStates[userId];
  console.log(`Estado actual del usuario ${userId}:`, userState);

  // Solo activa el bot con la palabra "pedido"
  if (userState.step === 0 && !message.body.toLowerCase().includes("pedido")) {
    console.log("Mensaje no contiene la palabra 'pedido', ignorando.");
    return; // Si el mensaje no contiene la palabra 'pedido', no activar el bot
  }

  if (!isWithinOperatingHours()) {
    await message.reply(
      "Nuestro horario de atención es de lunes a sábado de 11 AM a 10 PM, y domingo de 1 PM a 10 PM."
    );
    return;
  }

  if (userState.step === 0) {
    await message.reply(
      "Hola. Bienvenido a D'One Pizzería. ¿Cuál es tu nombre?"
    );
    userState.step = 1;
    console.log(`Usuario ${userId} en paso 1, esperando nombre.`);
  } else if (userState.step === 1) {
    userState.name = message.body;
    console.log(`Nombre del usuario ${userId}: ${userState.name}`);
    await message.reply(
      `¡Hola ${userState.name}! Déjame consultarle el menú...`
    );

    console.log("Obteniendo categorías del menú...");
    const menuCategories = await getMenuFromSheet(client.auth);
    console.log("Categorías obtenidas:", menuCategories);
    userState.menuCategories = menuCategories;
    let categoriesMessage = "Elige una categoría del menú:\n";
    Object.keys(menuCategories).forEach((cat, index) => {
      categoriesMessage += `${index + 1}. ${cat}\n`;
    });
    if (Object.keys(menuCategories).length === 0) {
      categoriesMessage =
        "Lo siento, no hay categorías disponibles en este momento.";
    }
    console.log("Mensaje de categorías:", categoriesMessage);
    await message.reply(categoriesMessage);
    userState.step = 2;
    console.log(
      `Usuario ${userId} en paso 2, esperando selección de categoría.`
    );
  } else if (userState.step === 2) {
    const categoryIndex = parseInt(message.body) - 1;
    const categories = Object.keys(userState.menuCategories);
    if (categoryIndex >= 0 && categoryIndex < categories.length) {
      const selectedCategory = categories[categoryIndex];
      userState.selectedCategory = selectedCategory;
      const items = userState.menuCategories[selectedCategory];
      let itemsMessage = `Has seleccionado ${selectedCategory}. Aquí están los productos disponibles:\n`;
      items.forEach((item, index) => {
        itemsMessage += `${index + 1}. ${item.name} - $${item.price}\n`;
      });
      itemsMessage += "\n0. Volver al menú principal";
      await message.reply(itemsMessage);
      userState.step = 3;
      console.log(
        `Usuario ${userId} en paso 3, esperando selección de producto.`
      );
    } else {
      await message.reply("Por favor, selecciona una categoría válida.");
    }
  } else if (userState.step === 3) {
    if (message.body === "0") {
      let categoriesMessage = "Elige una categoría del menú:\n";
      Object.keys(userState.menuCategories).forEach((cat, index) => {
        categoriesMessage += `${index + 1}. ${cat}\n`;
      });
      await message.reply(categoriesMessage);
      userState.step = 2;
      console.log(
        `Usuario ${userId} volvió al paso 2, selección de categoría.`
      );
    } else {
      const itemIndex = parseInt(message.body) - 1;
      const items = userState.menuCategories[userState.selectedCategory];
      if (itemIndex >= 0 && itemIndex < items.length) {
        const selectedItem = items[itemIndex];
        userState.selectedItem = selectedItem;
        await message.reply(
          `Has seleccionado ${userState.selectedCategory}: ${selectedItem.name}.\nDescripción: ${selectedItem.description}\nPrecio: $${selectedItem.price}\n\n¿Cuántos deseas ordenar?`
        );
        userState.step = 4;
        console.log(`Usuario ${userId} en paso 4, esperando cantidad.`);
      } else {
        await message.reply("Por favor, selecciona un producto válido.");
      }
    }
  } else if (userState.step === 4) {
    const quantity = parseInt(message.body);
    if (isNaN(quantity) || quantity <= 0) {
      await message.reply("Por favor, ingresa una cantidad válida.");
    } else {
      const selectedItem = userState.selectedItem;
      const orderTotal = selectedItem.price * quantity;
      userState.total += orderTotal;
      userState.orders.push({
        category: userState.selectedCategory,
        name: selectedItem.name,
        price: selectedItem.price,
        description: selectedItem.description,
        quantity: quantity,
      });

      await message.reply(
        `Has añadido ${quantity}x ${selectedItem.name} a tu pedido. ¿Deseas agregar algo más, ver promociones o finalizar el pedido?\n1. Agregar más productos\n2. Ver promociones\n3. Finalizar pedido\n4. Cancelar pedido`
      );
      userState.step = 5;
      console.log(`Usuario ${userId} en paso 5, esperando siguiente acción.`);
    }
  } else if (userState.step === 5) {
    if (message.body.toLowerCase() === "cancelar" || message.body === "4") {
      await message.reply(
        "Tu pedido ha sido cancelado. Gracias por visitar D'One Pizzería."
      );
      userState.step = 0;
      console.log(`Usuario ${userId} canceló el pedido, volvió al paso 0.`);
      return;
    }

    if (message.body === "1") {
      let categoriesMessage = "Elige una categoría del menú:\n";
      Object.keys(userState.menuCategories).forEach((cat, index) => {
        categoriesMessage += `${index + 1}. ${cat}\n`;
      });
      await message.reply(categoriesMessage);
      userState.step = 2;
      console.log(
        `Usuario ${userId} volvió al paso 2, selección de categoría.`
      );
    } else if (message.body === "2") {
      const promotionsCategory = "Promociones";
      userState.selectedCategory = promotionsCategory;
      const items = userState.menuCategories[promotionsCategory];
      let itemsMessage = `Aquí están nuestras promociones:\n`;
      items.forEach((item, index) => {
        itemsMessage += `${index + 1}. ${item.name} - $${item.price}\n`;
      });
      itemsMessage += "\n0. Volver al menú principal";
      await message.reply(itemsMessage);
      userState.step = 3;
      console.log(`Usuario ${userId} en paso 3, viendo promociones.`);
    } else if (message.body === "3") {
      if (userState.orders.length === 0) {
        await message.reply(
          "No tienes ningún producto en tu pedido. ¿Deseas cancelar el pedido?\n1. Sí\n2. No, seguir agregando productos"
        );
        userState.step = 6;
        console.log(`Usuario ${userId} en paso 6, confirmando cancelación.`);
      } else {
        let orderSummary = "Resumen de tu pedido:\n";
        userState.orders.forEach((order, index) => {
          orderSummary += `${index + 1}. ${order.quantity}x ${order.name} - $${
            order.price
          } cada uno\n`;
        });
        orderSummary += `\nTotal a pagar: $${userState.total.toFixed(
          2
        )}\n\n¿Cómo deseas recibir tu pedido?\n1. A domicilio\n2. Recoger en la pizzería\n3. Cancelar pedido`;
        await message.reply(orderSummary);
        userState.step = 6;
        console.log(
          `Usuario ${userId} en paso 6, eligiendo método de entrega.`
        );
      }
    } else {
      await message.reply("Por favor, selecciona una opción válida.");
    }
  } else if (userState.step === 6) {
    if (message.body.toLowerCase() === "cancelar" || message.body === "3") {
      await message.reply(
        "Tu pedido ha sido cancelado. Gracias por visitar D'One Pizzería."
      );
      userState.step = 0;
      console.log(`Usuario ${userId} canceló el pedido, volvió al paso 0.`);
      return;
    }

    if (message.body === "1") {
      await message.reply(
        "Por favor, proporciona la dirección de entrega o envía tu ubicación."
      );
      userState.step = 7;
      console.log(`Usuario ${userId} en paso 7, esperando dirección.`);
    } else if (message.body === "2") {
      userState.address = "Retiro en la pizzería";
      await message.reply(
        `Gracias ${userState.name}. Tu pedido será listo para recoger en nuestra ubicación: Centro Comercial Don Daniel: https://maps.app.goo.gl/WRMp4JR2qef7pAp77`
      );

      // Guardar el pedido en la hoja 'pedidos'
      userState.orders.forEach(async (order) => {
        const orderData = [
          userState.name,
          userId,
          order.category,
          `${order.quantity}x ${order.name}`,
          userState.total.toFixed(2),
          order.description,
          userState.address,
        ];
        console.log("Guardando pedido:", orderData);
        await saveOrder(client.auth, orderData);
      });

      userState.step = 0; // Reset the step for the next interaction
      userState.total = 0; // Reset the total for the next interaction
      userState.orders = []; // Reset the orders for the next interaction
      console.log(
        `Pedido completado para usuario ${userId}, volvió al paso 0.`
      );
    } else {
      await message.reply("Por favor, selecciona una opción válida.");
    }
  } else if (userState.step === 7) {
    if (message.type === "location") {
      const location = message.location;
      const locationLink = `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
      userState.address = locationLink;
      await message.reply(
        `Gracias ${userState.name}. Tu pedido será entregado en la dirección proporcionada. Estará listo en aproximadamente 30 minutos. ¡Que tengas un buen día!`
      );
    } else {
      userState.address = message.body;
      await message.reply(
        `Gracias ${userState.name}. Tu pedido será entregado en la dirección ${userState.address}. Estará listo en aproximadamente 30 minutos. ¡Que tengas un buen día!`
      );
    }

    // Enviar el pedido al número específico
    let orderInfo = `Nombre: ${userState.name}\nTeléfono: ${userId}\nProductos:\n`;
    userState.orders.forEach((order) => {
      orderInfo += `${order.quantity}x ${order.name} - $${order.price} cada uno\n`;
    });
    orderInfo += `\nTotal a pagar: $${userState.total.toFixed(2)}\nDirección: ${
      userState.address
    }`;
    await client.sendMessage("593995972366@c.us", orderInfo);

    // Guardar el pedido en la hoja 'pedidos'
    userState.orders.forEach(async (order) => {
      const orderData = [
        userState.name,
        userId,
        order.category,
        `${order.quantity}x ${order.name}`,
        userState.total.toFixed(2),
        order.description,
        userState.address,
      ];
      console.log("Guardando pedido:", orderData);
      await saveOrder(client.auth, orderData);
    });

    userState.step = 0; // Reset the step for the next interaction
    userState.total = 0; // Reset the total for the next interaction
    userState.orders = []; // Reset the orders for the next interaction
    console.log(`Pedido completado para usuario ${userId}, volvió al paso 0.`);
  } else {
    await message.reply("Por favor, selecciona una opción válida.");
  }
});

client.initialize().catch((error) => {
  console.error("Failed to initialize client:", error);
});
