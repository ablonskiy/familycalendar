import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Calendar, Bot, Shield, CheckCircle2, XCircle, ExternalLink, Settings } from 'lucide-react';

export default function App() {
  const [status, setStatus] = useState<{ connected: boolean } | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [calendars, setCalendars] = useState<any[]>([]);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>('primary');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const apiFetch = (path: string, options?: RequestInit) => {
    const baseUrl = import.meta.env.BASE_URL || '/';
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
    return fetch(`${normalizedBase}${normalizedPath}`, options);
  };

  const checkAuth = async () => {
    try {
      const res = await apiFetch('api/auth/check');
      const data = await res.json();
      setIsAuthenticated(data.authenticated);
      if (data.authenticated) {
        fetchStatus();
      }
    } catch (e) {
      console.error('Auth check failed', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchStatus = async () => {
    try {
      // First, check health to see if API is responding at all
      const healthRes = await apiFetch('api/health');
      if (!healthRes.ok) {
        const text = await healthRes.text();
        console.error('API Health check failed:', text);
        throw new Error('API server is not responding correctly (returned HTML instead of JSON)');
      }

      const healthData = await healthRes.json();
      console.log('Health data:', healthData);

      const [statusRes, botRes] = await Promise.all([
        apiFetch('api/status'),
        apiFetch('api/bot-info')
      ]);
      
      if (!statusRes.ok || !botRes.ok) {
        throw new Error('Failed to fetch bot status or info');
      }

      const statusData = await statusRes.json();
      const botData = await botRes.json();
      
      setStatus(statusData);
      setBotUsername(botData.username);

      if (statusData.connected) {
        const [calRes, settingsRes] = await Promise.all([
          apiFetch('api/calendars'),
          apiFetch('api/settings/calendar')
        ]);
        if (calRes.ok) setCalendars(await calRes.json());
        if (settingsRes.ok) {
          const s = await settingsRes.json();
          setSelectedCalendarId(s.calendarId);
        }
      }
      
      if (botData.username === 'bot_not_configured') {
        console.warn('Bot token is missing in server environment');
      }
    } catch (e: any) {
      console.error('Fetch error:', e);
      // If we get the JSON error, it means we got HTML
      if (e.message.includes('Unexpected token')) {
        console.error('SERVER RETURNED HTML INSTEAD OF JSON. Check server routes.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        fetchStatus();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleConnect = async () => {
    try {
      const res = await apiFetch('api/auth/url');
      const data = await res.json();
      
      if (!res.ok) {
        alert(`Ошибка: ${data.error || 'Не удалось получить ссылку авторизации'}`);
        return;
      }
      
      window.open(data.url, 'google_oauth', 'width=600,height=700');
    } catch (e) {
      alert('Ошибка при подключении к серверу');
    }
  };

  const handleCalendarChange = async (id: string) => {
    setSelectedCalendarId(id);
    try {
      await apiFetch('api/settings/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: id })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await apiFetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (res.ok) {
        setIsAuthenticated(true);
        fetchStatus();
      } else {
        setLoginError(data.error || 'Неверный пароль');
      }
    } catch (e) {
      setLoginError('Ошибка при подключении к серверу');
    }
  };

  const handleLogout = async () => {
    await apiFetch('api/logout', { method: 'POST' });
    setIsAuthenticated(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="animate-pulse text-zinc-400 font-medium">Загрузка...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-zinc-50">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-zinc-100 p-8"
        >
          <div className="flex items-center gap-3 mb-8">
            <div className="p-3 bg-indigo-600 rounded-2xl text-white">
              <Shield size={24} />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Вход в панель</h1>
              <p className="text-sm text-zinc-500">Введите пароль администратора</p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Пароль"
                className="w-full p-4 bg-zinc-50 border border-zinc-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                autoFocus
              />
              {loginError && <p className="mt-2 text-xs text-red-500 ml-1">{loginError}</p>}
            </div>
            <button
              type="submit"
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-semibold transition-all shadow-lg shadow-indigo-200"
            >
              Войти
            </button>
          </form>
          
          <p className="mt-6 text-center text-[10px] text-zinc-400 uppercase tracking-widest font-mono">
            Family Calendar Bot • Security Layer
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-zinc-50">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white rounded-3xl shadow-xl shadow-zinc-200/50 border border-zinc-100 p-8"
      >
        <div className="flex items-center gap-3 mb-8">
          <div className="p-3 bg-indigo-600 rounded-2xl text-white">
            <Bot size={24} />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Family Calendar Bot</h1>
            <p className="text-sm text-zinc-500">Панель управления</p>
          </div>
        </div>

        <div className="space-y-6">
          <section className="p-5 rounded-2xl bg-zinc-50 border border-zinc-100">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-zinc-700 font-medium">
                <Calendar size={18} />
                <span>Google Calendar</span>
              </div>
              {status?.connected ? (
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">
                  <CheckCircle2 size={12} /> Подключено
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
                  <XCircle size={12} /> Не подключено
                </span>
              )}
            </div>
            
            {!status?.connected && (
              <button
                onClick={handleConnect}
                className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-200"
              >
                Подключить Google аккаунт
              </button>
            )}
            
            {status?.connected ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-500 leading-relaxed">
                  Ваш календарь успешно подключен. Бот готов принимать команды в Telegram.
                </p>
                
                <button
                  onClick={handleConnect}
                  className="w-full py-2 px-4 border border-zinc-200 hover:bg-zinc-50 text-zinc-600 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2"
                >
                  <ExternalLink size={14} /> Обновить доступ / Сменить аккаунт
                </button>

                <div className="pt-2 border-t border-zinc-100">
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Целевой календарь
                  </label>
                  <select
                    value={selectedCalendarId}
                    onChange={(e) => handleCalendarChange(e.target.value)}
                    className="w-full p-3 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                  >
                    <option value="primary">Основной календарь</option>
                    {calendars.filter(c => c.id !== 'primary').map(cal => (
                      <option key={cal.id} value={cal.id}>
                        {cal.summary} {cal.primary ? '(Основной)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-[11px] text-zinc-400">
                    Выберите календарь, в который бот будет добавлять события.
                  </p>
                </div>
              </div>
            ) : null}
          </section>

          <section className="p-5 rounded-2xl bg-zinc-50 border border-zinc-100">
            <div className="flex items-center gap-2 text-zinc-700 font-medium mb-3">
              <Shield size={18} />
              <span>Безопасность</span>
            </div>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Бот отвечает только пользователям, чьи ID указаны в настройках окружения (<code className="bg-zinc-200 px-1 rounded text-xs">ALLOWED_USER_IDS</code>).
            </p>
          </section>

          <div className="pt-4 flex flex-col gap-3">
            {botUsername && botUsername !== 'bot_not_configured' && botUsername !== 'bot_error' ? (
              <a 
                href={`https://t.me/${botUsername}`} 
                target="_blank" 
                className="flex items-center justify-center gap-2 text-sm font-medium text-zinc-600 hover:text-indigo-600 transition-colors"
              >
                Открыть бота в Telegram (@{botUsername}) <ExternalLink size={14} />
              </a>
            ) : (
              <div className="text-sm text-amber-600 text-center bg-amber-50 p-2 rounded-lg border border-amber-100">
                Бот не настроен. Укажите TELEGRAM_BOT_TOKEN в Secrets.
              </div>
            )}
            <div className="text-[10px] text-center text-zinc-400 uppercase tracking-widest font-mono">
              v1.0.0 • Powered by Gemini AI
            </div>
            <button 
              onClick={handleLogout}
              className="text-[10px] text-center text-zinc-400 hover:text-red-500 transition-colors uppercase tracking-widest font-mono"
            >
              Выйти из системы
            </button>
          </div>
        </div>
      </motion.div>

      <div className="mt-8 max-w-2xl text-center">
        <h3 className="text-sm font-medium text-zinc-400 mb-4 flex items-center justify-center gap-2">
          <Settings size={14} /> Полное руководство по развертыванию
        </h3>
        <div className="text-[11px] text-zinc-400 leading-relaxed text-left bg-white/50 p-6 rounded-3xl border border-zinc-100 space-y-4 shadow-sm">
          <section>
            <h4 className="font-bold text-zinc-600 mb-1 uppercase tracking-wider">0. Установка Node.js (на сервере)</h4>
            <p>Если <code>npm</code> не найден, установите Node.js (рекомендуется v20+):</p>
            <pre className="bg-zinc-100 p-2 rounded mt-1 overflow-x-auto">
              curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -{"\n"}
              sudo apt-get install -y nodejs
            </pre>
          </section>

          <section>
            <h4 className="font-bold text-zinc-600 mb-1 uppercase tracking-wider">1. Подготовка (Git)</h4>
            <p>Скачайте проект и инициализируйте репозиторий на своем сервере (например, в <code>/var/www/familybot</code>):</p>
            <pre className="bg-zinc-100 p-2 rounded mt-1 overflow-x-auto">
              git init{"\n"}
              git add .{"\n"}
              git commit -m "Initial commit"
            </pre>
            <p className="mt-1 italic text-[10px]">Рекомендуется создать приватный репозиторий на GitHub/GitLab для удобных обновлений через <code>git pull</code>.</p>
          </section>

          <section>
            <h4 className="font-bold text-zinc-600 mb-1 uppercase tracking-wider">2. Настройка окружения</h4>
            <p>Создайте файл <code>.env</code> и заполните его ключами из раздела Secrets:</p>
            <ul className="list-disc ml-4 space-y-1">
              <li><code>TELEGRAM_BOT_TOKEN</code>, <code>OPENROUTER_API_KEY</code></li>
              <li><code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code></li>
              <li><code>ALLOWED_USER_IDS</code> (через запятую, например: <code>216052236,-1003120654038</code>)</li>
              <li><code>ADMIN_PASSWORD</code> (ваш секретный пароль для этой панели)</li>
              <li><code>APP_URL</code> (полный URL, например: <code>https://domain.com/familybot</code>)</li>
            </ul>
          </section>

          <section>
            <h4 className="font-bold text-zinc-600 mb-1 uppercase tracking-wider">3. Установка и сборка</h4>
            <pre className="bg-zinc-100 p-2 rounded mt-1 overflow-x-auto">
              npm install{"\n"}
              npm run build
            </pre>
          </section>

          <section>
            <h4 className="font-bold text-zinc-600 mb-1 uppercase tracking-wider">4. Запуск (PM2)</h4>
            <p>Для фоновой работы используйте PM2 и глобальный интерпретатор tsx:</p>
            <pre className="bg-zinc-100 p-2 rounded mt-1 overflow-x-auto">
              npm install -g pm2 tsx{"\n"}
              pm2 start server.ts --name familybot --interpreter tsx{"\n"}
              pm2 save
            </pre>
          </section>

          <section>
            <h4 className="font-bold text-zinc-600 mb-1 uppercase tracking-wider">5. Nginx (Reverse Proxy)</h4>
            <p>Если бот в подпапке <code>/familybot</code>, добавьте в конфиг домена (в блок <code>server</code> с портом 443):</p>
            <pre className="bg-zinc-100 p-2 rounded mt-1 overflow-x-auto">
              location ^~ /familybot {"{"}{"\n"}
              {"  "}rewrite ^/familybot$ /familybot/ permanent;{"\n"}
              {"  "}proxy_pass http://127.0.0.1:3000/;{"\n"}
              {"  "}proxy_set_header Host $host;{"\n"}
              {"  "}proxy_set_header X-Real-IP $remote_addr;{"\n"}
              {"}"}
            </pre>
          </section>
          <section className="bg-amber-50 p-3 rounded-xl border border-amber-100">
            <h4 className="font-bold text-amber-700 mb-1 uppercase tracking-wider text-[10px]">⚠️ Если ошибка 404 Not Found</h4>
            <ul className="list-disc ml-4 space-y-1 text-amber-800">
              <li>Убедитесь, что в <code>.env</code> стоит <code>NODE_ENV=production</code></li>
              <li>Проверьте, что <code>VITE_BASE_PATH=/familybot/</code> (со слешами!)</li>
              <li>Используйте относительные пути в API (без <code>/</code> в начале)</li>
              <li>После изменения <code>.env</code> <strong>обязательно</strong> заново запустите <code>npm run build</code></li>
              <li>Перезапустите бота: <code>pm2 restart familybot</code></li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
