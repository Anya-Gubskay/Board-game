import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid"; // Для генерации уникальных ID
import fs from "fs"; // Для работы с файлами
import dotenv from "dotenv"; // Для работы с переменными окружения

// Загружаем переменные окружения
dotenv.config();

// Определяем директорию проекта
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json()); // Для обработки JSON-запросов
app.use(express.static(path.join(__dirname, "public"))); // Раздаём статические файлы

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const rooms = {}; // Активные комнаты в памяти
const playerColors = ["red", "blue", "green", "yellow", "purple"];
const startPositions = [
  { x: 100, y: 100 }, // Первая фишка
  { x: 200, y: 200 }, // Вторая фишка (сдвиг на 100px)
  { x: 300, y: 100 },
  { x: 400, y: 100 },
  { x: 500, y: 100 }
];

// Файл для хранения комнат
const roomsFilePath = path.join(__dirname, "rooms.json");

// Создаем файл rooms.json, если он не существует
if (!fs.existsSync(roomsFilePath)) {
  try {
    fs.writeFileSync(roomsFilePath, JSON.stringify([]));
  } catch (err) {
    console.error("Ошибка при создании файла rooms.json:", err);
  }
}

// Загрузка существующих комнат из файла
let savedRooms = [];
try {
  savedRooms = JSON.parse(fs.readFileSync(roomsFilePath, "utf-8"));
} catch (err) {
  console.error("Ошибка при чтении файла rooms.json:", err);
}

// Сохранение комнат в файл
function saveRoomsToFile() {
  try {
    fs.writeFileSync(roomsFilePath, JSON.stringify(savedRooms, null, 2));
  } catch (err) {
    console.error("Ошибка при сохранении комнат в файл:", err);
  }
}

// Маршрут для отдачи create-room.html
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "create-room.html"));
});

// Endpoint для создания комнаты (доступен только вам)
app.post("/create-room", (req, res) => {
  const { password } = req.body;

  // Проверка пароля
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Доступ запрещен" });
  }

  // Генерация уникального roomId
  const roomId = uuidv4();
  savedRooms.push({ roomId, createdAt: new Date() });

  // Сохранение комнат в файл
  saveRoomsToFile();
  res.json({ roomId });
});

// Endpoint для проверки комнаты
app.get("/check-room", (req, res) => {
  const { roomId } = req.query;

  if (!roomId) {
    return res.status(400).json({ error: "Room ID is required" });
  }

  const roomExists = savedRooms.some((room) => room.roomId === roomId);
  res.json({ exists: roomExists });
});

// Endpoint для удаления комнаты
app.delete("/delete-room", (req, res) => {
  const { roomId, password } = req.body;

  // Проверка пароля
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Доступ запрещен" });
  }

  // Проверка, существует ли комната
  if (!savedRooms.some((room) => room.roomId === roomId)) {
    return res.status(404).json({ error: "Комната не найдена" });
  }

  // Удаление комнаты из сохраненных комнат
  savedRooms = savedRooms.filter((room) => room.roomId !== roomId);
  saveRoomsToFile();

  // Удаление комнаты из активных комнат в памяти
  if (rooms[roomId]) {
    // Уведомление всех игроков в комнате
    io.to(roomId).emit("roomDeleted", { message: "Комната удалена администратором" });
    delete rooms[roomId];
    console.log(`Комната ${roomId} удалена из памяти`);
  } else {
    console.log(`Комната ${roomId} не найдена в памяти`);
  }

  res.json({ success: true, message: `Комната ${roomId} удалена` });
});

// Логика Socket.IO
io.on("connection", (socket) => {
  console.log("Игрок подключился", socket.id);

  // Присоединение к комнате
  socket.on("joinRoom", (roomId) => {
    if (!roomId) {
      socket.emit("roomNotFound", { message: "Room ID is required" });
      return;
    }

    // Проверяем, существует ли комната в savedRooms
    const roomExists = savedRooms.some((room) => room.roomId === roomId);
    if (!roomExists) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
    }

    // Если комната существует, создаем её в памяти (если ещё не создана)
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], deck: shuffleDeck() };
    }

    // Проверяем, не превышено ли максимальное количество игроков
    if (rooms[roomId].players.length >= playerColors.length) {
      socket.emit("roomFull", { message: "Комната заполнена" });
      return;
    }

    // Назначаем цвет и позицию фишки
    const playerColor = playerColors[rooms[roomId].players.length % playerColors.length];
    const playerData = {
      id: socket.id,
      color: playerColor,
      position: {
        x: startPositions[rooms[roomId].players.length % playerColors.length].x,
        y: startPositions[rooms[roomId].players.length % playerColors.length].y,
      },
    };

    rooms[roomId].players.push(playerData);
    socket.join(roomId);

    // Отправляем обновлённый список игроков всем
    io.to(roomId).emit("updatePlayers", rooms[roomId].players);
  });

  // Обработка перемещения игрока
  socket.on("movePlayer", ({ roomId, x, y }) => {
    if (!rooms[roomId]) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
    }

    const player = rooms[roomId].players.find((p) => p.id === socket.id);
    if (player) {
      player.position = { x, y }; // Обновляем позицию игрока
      io.to(roomId).emit("updatePlayers", rooms[roomId].players); // Рассылаем обновление всем
    }
  });

  // Открытие модального окна
  socket.on("openModal", ({ roomId, category }) => {
    if (!rooms[roomId]) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
    }

    // Рассылаем событие открытия модального окна всем игрокам в комнате
    io.to(roomId).emit("openModal", { category });
  });

  // Закрытие модального окна
  socket.on("closeModal", (roomId) => {
    if (!rooms[roomId]) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
    }

    // Рассылаем событие закрытия модального окна всем игрокам в комнате
    io.to(roomId).emit("closeModal");
  });

     // Переворот изображения у всех игроков
     socket.on("flipImage", ({ roomId, category, newSrc, flipped }) => {
      if (!rooms[roomId]) {
        socket.emit("roomNotFound", { message: "Комната не найдена" });
        return;
      }
      io.to(roomId).emit("flipImage", { category, newSrc, flipped });
  });

  // Обработка отключения игрока
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter((p) => p.id !== socket.id);
      io.to(roomId).emit("updatePlayers", rooms[roomId].players);
    }
  });
});

// Функция для перемешивания карточек
function shuffleDeck() {
  return ["Карточка 1", "Карточка 2", "Карточка 3"].sort(() => Math.random() - 0.5);
}

// Раздаём index.html при заходе на "/"
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));