import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { saveRoomsToSupabase, loadRoomsFromSupabase } from "./supabase.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});


const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let rooms = {}; // Должно быть `let`, а не `const`

(async () => {
  try {
    rooms = await loadRoomsFromSupabase();
    console.log("✅ Комнаты загружены из Supabase");
  } catch (error) {
    console.error("❌ Ошибка загрузки комнат из Supabase:", error);
    rooms = {}; // Если ошибка, создаем пустой объект
  }
})();

const playerColors = ["red", "blue", "green", "yellow", "purple"];
const startPositions = [
  { xPercent: 10, yPercent: 10 }, 
  { xPercent: 20, yPercent: 10 }, 
  { xPercent: 30, yPercent: 10 }, 
  { xPercent: 40, yPercent: 10 }, 
  { xPercent: 50, yPercent: 10 }
];
const roomsFilePath = path.join(__dirname, "rooms.json");

// Загружаем комнаты из файла при старте сервера
if (fs.existsSync(roomsFilePath)) {
  try {
      const data = fs.readFileSync(roomsFilePath, "utf-8");
      rooms = data ? JSON.parse(data) : {};
      console.log("✅ Загружены комнаты из файла");
  } catch (err) {
      console.error("❌ Ошибка при загрузке комнат, создаем пустой объект:", err);
      rooms = {};
  }
}

// Функция сохранения комнат`
async function saveRoomsToFile() {
  try {
    await saveRoomsToSupabase(rooms);
    console.log("✅ Комнаты сохранены в Supabase");
  } catch (error) {
    console.error("❌ Ошибка при сохранении в Supabase:", error);
  }
}
// Проверка комнаты
app.get("/check-room", (req, res) => {
  const { roomId } = req.query;

  if (!rooms[roomId]) {
    return res.status(404).json({ error: "Комната не найдена" });
  }

  return res.json({ exists: true });
});

// Создание комнаты
app.post("/create-room", (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Доступ запрещен" });
  }

  const roomId = uuidv4();
  rooms[roomId] = { players: []};

  saveRoomsToFile();

  res.json({ roomId });
});

// Удаление комнаты
app.delete("/delete-room", (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Доступ запрещен" });
  }

  if (!rooms[req.body.roomId]) {
      return res.status(404).json({ error: "Комната не найдена" });
  }

  io.to(req.body.roomId).emit("roomDeleted", { message: "Комната удалена" });
  delete rooms[req.body.roomId];
  saveRoomsToFile();

  res.json({ success: true });
});

let shutdownTimeout;
// Логика Socket.IO
io.on("connection", (socket) => {
  console.log("Игрок подключился:", socket.id);

  clearTimeout(shutdownTimeout); // Отключаем таймер, если игрок зашел

  console.log("Игрок подключился", socket.id);

// Присоединение к комнате
socket.on("joinRoom", (roomId) => {
  if (!roomId) {
      socket.emit("roomNotFound", { message: "Room ID is required" });
      return;
  }

  if (!rooms[roomId]) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
  }

  if (rooms[roomId].players.length >= playerColors.length) {
      socket.emit("roomFull", { message: "Комната заполнена" });
      return;
  }

  // Найти свободную позицию
  let position;
  for (let i = 0; i < startPositions.length; i++) {
      let isOccupied = rooms[roomId].players.some(p => p.position.xPercent === startPositions[i].xPercent && p.position.yPercent === startPositions[i].yPercent);
      if (!isOccupied) {
          position = startPositions[i];
          break;
      }
  }

  if (!position) {
      // Если все стандартные позиции заняты, ставим в случайное место
      position = {
          xPercent: Math.random() * 80 + 10, // От 10% до 90%
          yPercent: Math.random() * 80 + 10
      };
  }

  const playerData = {
      id: socket.id,
      color: playerColors[rooms[roomId].players.length % playerColors.length],
      position: position,
  };

  rooms[roomId].players.push(playerData);
  socket.join(roomId);
  saveRoomsToFile();

  io.to(roomId).emit("updatePlayers", rooms[roomId].players);
});


// Обработка перемещения игрока
socket.on("movePlayer", ({ roomId, xPercent, yPercent }) => {
  if (!rooms[roomId]) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
  }

  const player = rooms[roomId].players.find((p) => p.id === socket.id);
  if (player) {
    player.position.xPercent = xPercent;
    player.position.yPercent = yPercent;
    io.to(roomId).emit("updatePlayers", rooms[roomId].players);
}
});

socket.on("rollDice", ({ roomId, roll }) => {
  if (!rooms[roomId]) {
      socket.emit("roomNotFound", { message: "Комната не найдена" });
      return;
  }

  io.to(roomId).emit("rollDiceResult", { roll });
});

// Открытие модального окна
socket.on("openModal", ({ roomId, category }) => {
  if (!rooms[roomId]) {
    socket.emit("roomNotFound", { message: "Комната не найдена" });
    return;
  }
  io.to(roomId).emit("openModal", { category });
});

// Закрытие модального окна
socket.on("closeModal", (roomId) => {
  if (!rooms[roomId]) {
    socket.emit("roomNotFound", { message: "Комната не найдена" });
    return;
  }
  io.to(roomId).emit("closeModal");
});

// Переворот изображения
socket.on("flipImage", ({ roomId, category, newSrc, flipped }) => {
  if (!rooms[roomId]) {
    socket.emit("roomNotFound", { message: "Комната не найдена" });
    return;
  }
  io.to(roomId).emit("flipImage", { category, newSrc, flipped });
});

socket.on("leaveRoom", ({ roomId, playerId }) => {
  if (!rooms[roomId]) return;

  // Удаляем игрока из списка
  rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== playerId);

  // Сообщаем остальным игрокам об обновлении списка
  io.to(roomId).emit("updatePlayers", rooms[roomId].players);

  console.log(`Игрок ${playerId} покинул комнату ${roomId}`);
});


// Отключение игрока
socket.on("disconnect", () => {
  for (const roomId in rooms) {
    rooms[roomId].players = rooms[roomId].players.filter((p) => p.id !== socket.id);
    io.to(roomId).emit("updatePlayers", rooms[roomId].players);
  }
  console.log("Игрок отключился:", socket.id);
});
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
