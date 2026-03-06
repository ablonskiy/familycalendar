import express from "express";
import { createServer as createViteServer } from "vite";
import { Telegraf, Markup } from "telegraf";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import { parseEventMessage, refineEventMessage } from "./src/services/aiService";
import { getAuthUrl, setTokens, addCalendarEvent, listCalendars, getEvents, getCalendarTimezone } from "./src/services/calendarService";
import db from "./src/db";
import { formatInTimeZone } from 'date-fns-tz';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());
  app.use(cookieParser("family-calendar-secret")); // Secret for signed cookies

  // 1. AUTH MIDDLEWARE
  const authMiddleware = (req: any, res: any, next: any) => {
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    // If password is not set in env, allow access (for initial setup)
    if (!adminPassword || adminPassword === "your_secure_password") {
      return next();
    }

    const authCookie = req.signedCookies.admin_auth;
    if (authCookie === "true") {
      return next();
    }
    
    res.status(401).json({ error: "Unauthorized" });
  };

  // Diagnostic log
  console.log("Server starting...");
  console.log("TELEGRAM_BOT_TOKEN present:", !!process.env.TELEGRAM_BOT_TOKEN);
  console.log("GOOGLE_CLIENT_ID present:", !!process.env.GOOGLE_CLIENT_ID);
  console.log("OPENROUTER_API_KEY present:", !!process.env.OPENROUTER_API_KEY);

  // 1. API ROUTES FIRST
  app.use((req, res, next) => {
    // Collapse multiple slashes (e.g. //api -> /api)
    req.url = req.url.replace(/\/+/g, '/');
    
    if (process.env.NODE_ENV === "production") {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    }
    next();
  });

  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      env: {
        bot_token: !!process.env.TELEGRAM_BOT_TOKEN,
        google_id: !!process.env.GOOGLE_CLIENT_ID,
        openrouter: !!process.env.OPENROUTER_API_KEY,
        admin_password: !!process.env.ADMIN_PASSWORD
      }
    });
  });

  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword || adminPassword === "your_secure_password") {
      return res.json({ success: true, message: "No password set, access granted" });
    }

    if (password === adminPassword) {
      res.cookie("admin_auth", "true", { 
        httpOnly: true, 
        signed: true, 
        maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
        sameSite: 'lax'
      });
      return res.json({ success: true });
    }

    res.status(401).json({ error: "Invalid password" });
  });

  app.get("/api/auth/check", (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword === "your_secure_password") {
      return res.json({ authenticated: true });
    }
    const authCookie = req.signedCookies.admin_auth;
    res.json({ authenticated: authCookie === "true" });
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie("admin_auth");
    res.json({ success: true });
  });

  // Apply auth middleware to all other API routes
  app.use("/api/calendars", authMiddleware);
  app.use("/api/settings", authMiddleware);
  app.use("/api/bot-info", authMiddleware);
  app.use("/api/status", authMiddleware);
  app.use("/api/auth/url", authMiddleware);

  app.get("/api/calendars", async (req, res) => {
    try {
      const calendars = await listCalendars();
      res.json(calendars);
    } catch (e) {
      console.error("List calendars error:", e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/settings/calendar", (req, res) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('calendar_id') as any;
      res.json({ calendarId: row ? row.value : 'primary' });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post("/api/settings/calendar", (req, res) => {
    const { calendarId } = req.body;
    if (!calendarId) return res.status(400).json({ error: "Missing calendarId" });
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('calendar_id', calendarId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/bot-info", async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === "your_bot_token" || token.length < 10) {
      return res.json({ username: "bot_not_configured" });
    }
    try {
      const bot = new Telegraf(token);
      const info = await bot.telegram.getMe();
      res.json({ username: info.username });
    } catch (e) {
      console.error("Bot info error:", e);
      res.json({ username: "bot_error", error: String(e) });
    }
  });

  app.get("/api/status", (req, res) => {
    try {
      const row = db.prepare('SELECT tokens FROM google_tokens WHERE user_email = ?').get('primary') as any;
      res.json({ connected: !!row });
    } catch (e) {
      console.error("Status error:", e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/auth/url", (req, res) => {
    try {
      res.json({ url: getAuthUrl() });
    } catch (e: any) {
      console.error("Auth URL error:", e);
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    if (typeof code !== 'string') return res.status(400).send('Invalid code');
    try {
      await setTokens(code);
      res.send('<html><body><h1>Успешно!</h1><script>setTimeout(() => { if(window.opener) { window.opener.postMessage({type:"OAUTH_AUTH_SUCCESS"}, "*"); window.close(); } }, 2000);</script></body></html>');
    } catch (error) {
      console.error("Callback error:", error);
      res.status(500).send('Auth failed');
    }
  });

  // 2. TELEGRAM BOT SETUP
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && token !== "your_bot_token") {
    const bot = new Telegraf(token);
    const allowedIds = (process.env.ALLOWED_USER_IDS || "").split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));

    const getValidTz = (input: string) => {
      const clean = input.replace(/['"]/g, '').trim();
      const mapping: Record<string, string> = {
        'Belgrade': 'Europe/Belgrade',
        'Moscow': 'Europe/Moscow',
        'London': 'Europe/London',
        'Paris': 'Europe/Paris',
        'Berlin': 'Europe/Berlin',
        'Kiev': 'Europe/Kiev',
        'Kyiv': 'Europe/Kiev',
        'Dubai': 'Asia/Dubai',
      };
      if (mapping[clean]) return mapping[clean];
      try {
        Intl.DateTimeFormat(undefined, { timeZone: clean });
        return clean;
      } catch (e) {
        return 'UTC';
      }
    };

    bot.use(async (ctx, next) => {
      if (!ctx.from || !ctx.chat) return;

      if (ctx.chat.type === 'private') {
        console.log(`Incoming message from user ${ctx.from.id} in chat ${ctx.chat.id} (${ctx.chat.type}): ${ctx.message && 'text' in ctx.message ? ctx.message.text : '[not text]'}`);
      }

      const isUserAllowed = allowedIds.includes(ctx.from.id);
      const isChatAllowed = allowedIds.includes(ctx.chat.id) || 
                            allowedIds.includes(Math.abs(ctx.chat.id)) ||
                            allowedIds.includes(parseInt(ctx.chat.id.toString().replace('-100', '')));

      if (allowedIds.length > 0 && !isUserAllowed && !isChatAllowed) {
        console.log(`Access DENIED for User ID: ${ctx.from.id}, Chat ID: ${ctx.chat.id}. Allowed IDs: ${allowedIds.join(', ')}`);
        
        const botInfo = await bot.telegram.getMe();
        const isMentioned = ctx.message && 'text' in ctx.message && ctx.message.text.includes(`@${botInfo.username}`);
        
        if (ctx.chat.type === 'private' || isMentioned) {
          await ctx.reply(`⛔️ Доступ запрещен.\n\nВаш ID: ${ctx.from.id}\nID чата: ${ctx.chat.id}\n\nДобавьте нужный ID в настройки (ALLOWED_USER_IDS) через запятую.`);
        }
        return;
      }
      return next();
    });

    bot.command("start", async (ctx) => {
      await ctx.reply(`Привет! Я бот для семейного календаря.\nВаш Telegram ID: ${ctx.from.id}\nID этого чата: ${ctx.chat.id}\nОтправьте мне сообщение с описанием события, чтобы добавить его в календарь.`);
    });

    bot.command("debug", async (ctx) => {
      await ctx.reply(`🔍 Отладка:\nВаш ID: ${ctx.from.id}\nID чата: ${ctx.chat.id}\nТип чата: ${ctx.chat.type}\nРазрешенные ID: ${process.env.ALLOWED_USER_IDS || "не заданы"}`);
    });

    bot.on("text", async (ctx, next) => {
      const session = db.prepare('SELECT state, data FROM sessions WHERE chat_id = ?').get(ctx.chat.id) as any;
      
      if (session && session.state === 'EDITING') {
        const previousData = JSON.parse(session.data);
        const newMessage = ctx.message.text;

        try {
          ctx.reply("Обновляю данные... 🔄");
          const now = new Date();
          const tz = await getCalendarTimezone();

          let currentTime;
          try {
            currentTime = formatInTimeZone(now, tz, 'yyyy-MM-dd HH:mm:ss');
          } catch (tzError: any) {
            currentTime = formatInTimeZone(now, 'UTC', 'yyyy-MM-dd HH:mm:ss');
          }

          const updated = await refineEventMessage(previousData, newMessage, currentTime);
          
          db.prepare('UPDATE sessions SET state = ?, data = ? WHERE chat_id = ?')
            .run('CONFIRMING', JSON.stringify(updated), ctx.chat.id);

          const responseText = `📅 **Обновленные данные:**
📌 Название: ${updated.title}
🗓 Дата: ${updated.date}
⏰ Время: ${updated.time}
⏳ Длительность: ${updated.durationMinutes} мин.
📍 Место: ${updated.location || "Не указано"}
📝 Описание: ${updated.description || "-"}

Теперь все верно?`;

          return await ctx.replyWithMarkdown(responseText, Markup.inlineKeyboard([
            [Markup.button.callback("✅ Добавить", "add_event")],
            [Markup.button.callback("✏️ Исправить", "edit_event")],
            [Markup.button.callback("❌ Отменить", "cancel_event")]
          ]));
        } catch (error: any) {
          console.error("Refine error:", error);
          ctx.reply(`❌ Ошибка при обновлении: ${error.message || "Неизвестная ошибка"}`);
        }
      }

      const message = ctx.message.text;
      let botUsername = "";
      try {
        const botInfo = await bot.telegram.getMe();
        botUsername = botInfo.username;
      } catch (e) {
        console.error("Could not get bot info", e);
      }
      
      const isChatExplicitlyAllowed = allowedIds.includes(ctx.chat.id) || 
                                      allowedIds.includes(Math.abs(ctx.chat.id)) ||
                                      allowedIds.includes(parseInt(ctx.chat.id.toString().replace('-100', '')));
      
      // Strictly require mention in groups to save tokens, even if chat is allowed
      if (ctx.chat.type !== 'private' && botUsername && !message.includes(`@${botUsername}`)) {
        return;
      }

      if (ctx.chat.type !== 'private') {
        console.log(`Incoming message from user ${ctx.from.id} in chat ${ctx.chat.id} (${ctx.chat.type}): ${message}`);
      }

      const cleanMessage = botUsername ? message.replace(`@${botUsername}`, "").trim() : message.trim();
      if (!cleanMessage) return;

      try {
        const now = new Date();
        const tz = await getCalendarTimezone();
        console.log(`Timezone debug: using "${tz}" (from Google Calendar)`);
        
        let currentTime;
        try {
          currentTime = formatInTimeZone(now, tz, 'yyyy-MM-dd HH:mm:ss');
        } catch (tzError: any) {
          console.error("formatInTimeZone failed with tz:", tz, tzError);
          // Fallback to UTC if timezone is invalid
          currentTime = formatInTimeZone(now, 'UTC', 'yyyy-MM-dd HH:mm:ss');
          ctx.reply(`⚠️ Предупреждение: Часовой пояс "${tz}" не распознан. Использую UTC.`);
        }
        
        ctx.reply("Анализирую ваше сообщение... ⏳");
        const aiResponse = await parseEventMessage(cleanMessage, currentTime, tz);
        
        if (aiResponse.intent === 'QUERY' && aiResponse.query) {
          const { startDate, endDate } = aiResponse.query;
          const events = await getEvents(startDate, endDate);
          
          if (events.length === 0) {
            return ctx.reply(`📅 На период с ${startDate} по ${endDate} событий не найдено. День свободен! 🕊`);
          }

          let responseText = `📅 **Запланированные события (${startDate} - ${endDate}):**\n\n`;
          
          // Group events by date
          const grouped: Record<string, any[]> = {};
          events.forEach(e => {
            const date = (e.start.dateTime || e.start.date).split('T')[0];
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
          });

          Object.keys(grouped).sort().forEach(date => {
            responseText += `🗓 **${date}:**\n`;
            grouped[date].forEach(e => {
              const time = e.start.dateTime ? formatInTimeZone(new Date(e.start.dateTime), tz, 'HH:mm') : "Весь день";
              responseText += `  • ${time} — ${e.summary}\n`;
            });
            responseText += '\n';
          });

          return ctx.replyWithMarkdown(responseText);
        }

        if (aiResponse.intent === 'ADD' && aiResponse.event) {
          const parsed = aiResponse.event;
          db.prepare('INSERT OR REPLACE INTO sessions (chat_id, state, data) VALUES (?, ?, ?)')
            .run(ctx.chat.id, 'CONFIRMING', JSON.stringify(parsed));

          const responseText = `📅 **Событие распознано:**
📌 Название: ${parsed.title}
🗓 Дата: ${parsed.date}
⏰ Время: ${parsed.time}
⏳ Длительность: ${parsed.durationMinutes} мин.
📍 Место: ${parsed.location || "Не указано"}
📝 Описание: ${parsed.description || "-"}

Все верно?`;

          await ctx.replyWithMarkdown(responseText, Markup.inlineKeyboard([
            [Markup.button.callback("✅ Добавить", "add_event")],
            [Markup.button.callback("✏️ Исправить", "edit_event")],
            [Markup.button.callback("❌ Отменить", "cancel_event")]
          ]));
        }
      } catch (error: any) {
        console.error("Parse error:", error);
        let errorMsg = "❌ Произошла ошибка при анализе сообщения.";
        if (error.message?.includes("OPENROUTER_API_KEY")) {
          errorMsg += "\n\nПохоже, не настроен ключ OpenRouter. Пожалуйста, добавьте OPENROUTER_API_KEY в Secrets.";
        } else if (error.status === 401 || error.status === 403) {
          errorMsg += "\n\nОшибка авторизации в OpenRouter. Проверьте правильность API ключа.";
        } else {
          errorMsg += `\n\nДетали: ${error.message || "Неизвестная ошибка"}`;
        }
        ctx.reply(errorMsg);
      }
    });

    bot.action("add_event", async (ctx) => {
      const session = db.prepare('SELECT data FROM sessions WHERE chat_id = ?').get(ctx.chat?.id) as any;
      if (!session) return ctx.answerCbQuery("Сессия не найдена.");
      const eventData = JSON.parse(session.data);
      try {
        await ctx.answerCbQuery("Добавляю...");
        const result = await addCalendarEvent(eventData);
        
        // Keep the original text but remove buttons and add success message
        const originalText = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : "";
        const successText = `${originalText}\n\n✅ **Добавлено в календарь!**\n🔗 [Открыть в Google Календаре](${result.htmlLink})`;
        
        await ctx.editMessageText(successText, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
        db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(ctx.chat?.id);
      } catch (error: any) {
        console.error("Add event error:", error);
        await ctx.reply(`❌ Ошибка при добавлении: ${error.message}`);
      }
    });

    bot.action("edit_event", async (ctx) => {
      db.prepare('UPDATE sessions SET state = ? WHERE chat_id = ?').run('EDITING', ctx.chat?.id);
      await ctx.editMessageText("Напишите уточнение (например: 'перенеси на 18:00')");
    });

    bot.action("cancel_event", async (ctx) => {
      db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(ctx.chat?.id);
      await ctx.editMessageText("❌ Отменено.");
    });

    bot.launch().then(() => console.log("Bot launched")).catch(err => console.error("Bot launch error:", err));
  } else {
    console.warn("TELEGRAM_BOT_TOKEN is missing or default. Bot not started.");
  }

  // 3. VITE MIDDLEWARE LAST
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const path = await import('path');
    const distPath = path.join(process.cwd(), "dist");
    
    console.log(`Production mode: serving static files from ${distPath}`);
    
    // Serve static files from dist
    app.use(express.static(distPath));
    
    // SPA fallback: serve index.html for any unknown routes
    app.get("*", (req, res) => {
      // Don't fallback for API routes
      if (req.url.startsWith('/api/')) {
        return res.status(404).json({ error: "API route not found" });
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`OPENROUTER_API_KEY present: ${!!process.env.OPENROUTER_API_KEY}`);
  });
}

startServer().catch(err => {
  console.error("CRITICAL: Server failed to start:", err);
});
