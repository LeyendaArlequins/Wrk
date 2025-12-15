// =================== DURABLE OBJECT ===================
class CounterDurableObject {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env;

        state.blockConcurrencyWhile(async () => {
            const saved = await this.storage.get("stats");

            if (saved) {
                this.stats = {
                    ...saved,
                    uniqueUsers: new Map(Object.entries(saved.uniqueUsers || {})),
                    sessions: new Map(Object.entries(saved.sessions || {})),
                    hourlyStats: new Map(Object.entries(saved.hourlyStats || {})),
                    dailyStats: new Map(Object.entries(saved.dailyStats || {})),
                };
            } else {
                this.stats = {
                    total: 0,
                    today: 0,
                    online: 0,
                    uniqueUsers: new Map(),
                    sessions: new Map(),
                    hourlyStats: new Map(),
                    dailyStats: new Map(),
                    peakOnline: 0,
                    peakToday: 0,
                    lastReset: new Date().toDateString(),
                    requestsCount: 0
                };
            }
        });
    }

    // Fetch handler para el Durable Object
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        // Headers CORS
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json'
        };

        // OPTIONS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers });
        }

        try {
            let result;
            
            switch(path) {
                case '/increment':
                    const params = Object.fromEntries(url.searchParams);
                    result = await this.incrementCounters(params);
                    break;
                    
                case '/counter':
                    result = await this.getCounterStats();
                    break;
                    
                case '/stats':
                    result = await this.getDetailedStats();
                    break;
                    
                case '/heartbeat':
                    const { sessionId, userId } = Object.fromEntries(url.searchParams);
                    result = await this.updateHeartbeat(sessionId, userId);
                    break;
                    
                default:
                    return new Response(JSON.stringify({ error: 'Endpoint no encontrado' }), {
                        status: 404,
                        headers
                    });
            }
            
            return new Response(JSON.stringify(result), { headers });
            
        } catch (error) {
            return new Response(JSON.stringify({ 
                error: 'Error interno',
                message: error.message 
            }), {
                status: 500,
                headers
            });
        }
    }

    // Incrementar contadores
    async incrementCounters({ userId, playerName, sessionId, gameId }) {
        this.cleanupSessions();
        this.checkDailyReset();
        
        const now = new Date();
        const today = now.toDateString();
        const hourKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${now.getHours()}`;
        
        // Incrementar
        this.stats.total++;
        this.stats.today++;
        this.stats.requestsCount++;
        
        // Peak today
        if (this.stats.today > this.stats.peakToday) {
            this.stats.peakToday = this.stats.today;
        }
        
        // Usuario único
        const userKey = `user_${userId}`;
        if (!this.stats.uniqueUsers.has(userKey)) {
            this.stats.uniqueUsers.set(userKey, {
                userId,
                playerName: playerName || `User_${userId}`,
                firstSeen: now.toISOString(),
                lastSeen: now.toISOString(),
                totalExecutions: 1
            });
        } else {
            const user = this.stats.uniqueUsers.get(userKey);
            user.totalExecutions++;
            user.lastSeen = now.toISOString();
        }
        
        // Sesión
        if (sessionId) {
            this.stats.sessions.set(sessionId, {
                userId,
                playerName: playerName || `User_${userId}`,
                lastHeartbeat: Date.now(),
                created: Date.now(),
                gameId
            });
            this.stats.online = this.stats.sessions.size;
            
            if (this.stats.online > this.stats.peakOnline) {
                this.stats.peakOnline = this.stats.online;
            }
        }
        
        // Guardar estado
        await this.saveStats();
        
        return {
            success: true,
            stats: {
                total: this.stats.total,
                today: this.stats.today,
                online: this.stats.online,
                unique: this.stats.uniqueUsers.size,
                yourTotal: this.stats.uniqueUsers.get(userKey)?.totalExecutions || 1
            },
            timestamp: now.toISOString()
        };
    }

    // Obtener contador
    async getCounterStats() {
        this.cleanupSessions();
        this.checkDailyReset();
        
        return {
            total: this.stats.total,
            today: this.stats.today,
            online: this.stats.online,
            unique: this.stats.uniqueUsers.size,
            peakOnline: this.stats.peakOnline,
            peakToday: this.stats.peakToday,
            lastUpdate: new Date().toISOString()
        };
    }

    // Obtener estadísticas detalladas (añadir este método que falta)
    async getDetailedStats() {
        this.cleanupSessions();
        this.checkDailyReset();
        
        return {
            total: this.stats.total,
            today: this.stats.today,
            online: this.stats.online,
            unique: this.stats.uniqueUsers.size,
            peakOnline: this.stats.peakOnline,
            peakToday: this.stats.peakToday,
            requestsCount: this.stats.requestsCount,
            lastReset: this.stats.lastReset,
            lastUpdate: new Date().toISOString()
        };
    }

    // Limpiar sesiones
    cleanupSessions() {
        const now = Date.now();
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            if (now - session.lastHeartbeat > 45000) {
                this.stats.sessions.delete(sessionId);
            }
        }
        this.stats.online = this.stats.sessions.size;
    }

    // Reset diario
    checkDailyReset() {
        const today = new Date().toDateString();
        if (this.stats.lastReset !== today) {
            this.stats.today = 0;
            this.stats.peakToday = 0;
            this.stats.lastReset = today;
        }
    }

    // Heartbeat
    async updateHeartbeat(sessionId, userId) {
        this.cleanupSessions();
        
        if (sessionId && this.stats.sessions.has(sessionId)) {
            const session = this.stats.sessions.get(sessionId);
            if (session.userId === userId) {
                session.lastHeartbeat = Date.now();
                await this.saveStats();
                return { success: true, online: this.stats.online };
            }
        }
        
        return { success: false, online: this.stats.online };
    }

    // Guardar estado
    async saveStats() {
        // Convertir Maps a objetos para almacenamiento
        const toSave = {
            ...this.stats,
            uniqueUsers: Object.fromEntries(this.stats.uniqueUsers),
            sessions: Object.fromEntries(this.stats.sessions),
            hourlyStats: Object.fromEntries(this.stats.hourlyStats),
            dailyStats: Object.fromEntries(this.stats.dailyStats)
        };
        
        await this.storage.put('stats', toSave);
    }
}

// =================== WORKER PRINCIPAL ===================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        // Headers CORS
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        };

        // OPTIONS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers });
        }

        // Obtener el Durable Object ID (estado persistente)
        const id = env.CONTADOR_STATS.idFromName('main');
        const obj = env.CONTADOR_STATS.get(id);
        
        // Redirigir al Durable Object para operaciones de estado
        if (path === '/api/count' || path === '/api/count.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/increment';
            return obj.fetch(newUrl);
        }
        
        if (path === '/api/counter' || path === '/api/counter.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/counter';
            return obj.fetch(newUrl);
        }
        
        if (path === '/api/stats' || path === '/api/stats.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/stats';
            return obj.fetch(newUrl);
        }
        
        if (path === '/api/heartbeat' || path === '/api/heartbeat.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/heartbeat';
            return obj.fetch(newUrl);
        }
        
        // Script para Roblox
        if (path === '/api/script' || path === '/api/script.js') {
            const baseUrl = `https://${url.hostname}`;
            
            const script = `-- 🏆 CONTADOR DORADO - Cloudflare Workers 🏆
-- Estado PERSISTENTE - Sin pérdida de datos
-- URL: ${baseUrl}

local API = "${baseUrl}/api"
local player = game.Players.LocalPlayer
local sessionId = "S_" .. player.UserId .. "_" .. math.random(1000,9999)

-- Función principal
local function register()
    local url = API .. "/count.js?userId=" .. player.UserId .. 
               "&playerName=" .. player.Name .. 
               "&sessionId=" .. sessionId .. 
               "&gameId=" .. game.GameId .. 
               "&time=" .. os.time()
    
    local success, result = pcall(function()
        local req = game:GetService("HttpService"):RequestAsync{
            Url = url,
            Method = "GET"
        }
        return req.Body
    end)
    
    if success then
        print("✅ CONTADOR DORADO ACTIVADO")
        -- Parsear JSON
        local jsonSuccess, data = pcall(function()
            return game:GetService("HttpService"):JSONDecode(result)
        end)
        if jsonSuccess then
            print("📊 Total: " .. tostring(data.stats.total))
            print("👥 Online: " .. tostring(data.stats.online))
        end
    end
end

-- Heartbeat
local function heartbeat()
    pcall(function()
        game:GetService("HttpService"):RequestAsync{
            Url = API .. "/heartbeat.js?sessionId=" .. sessionId .. "&userId=" .. player.UserId,
            Method = "GET"
        }
    end)
end

-- Iniciar
register()

-- Heartbeat cada 30s
while true do
    task.wait(30)
    heartbeat()
end`;
            
            return new Response(script, {
                headers: {
                    'Content-Type': 'text/plain',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        // Servir página web
        if (path === "/" || path === "/index.html") {
            const indexHtml = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Contador Dorado 🏆</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Arial', sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: white;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            text-align: center;
        }
        .header {
            margin-bottom: 40px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        .stat-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 15px;
            padding: 25px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            transition: transform 0.3s;
        }
        .stat-card:hover {
            transform: translateY(-5px);
        }
        .stat-value {
            font-size: 3em;
            font-weight: bold;
            margin: 10px 0;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .stat-label {
            font-size: 1.2em;
            opacity: 0.9;
        }
        .instructions {
            background: rgba(0, 0, 0, 0.2);
            padding: 25px;
            border-radius: 15px;
            margin: 30px 0;
            text-align: left;
        }
        code {
            background: rgba(0,0,0,0.3);
            padding: 3px 8px;
            border-radius: 5px;
            font-family: monospace;
        }
        h1 {
            font-size: 3em;
            margin-bottom: 10px;
        }
        h2 {
            margin: 20px 0;
        }
        .refresh-btn {
            background: linear-gradient(45deg, #f093fb 0%, #f5576c 100%);
            border: none;
            padding: 15px 30px;
            font-size: 1.2em;
            border-radius: 50px;
            color: white;
            cursor: pointer;
            margin-top: 20px;
            transition: transform 0.3s;
        }
        .refresh-btn:hover {
            transform: scale(1.05);
        }
        .gold {
            color: gold;
            text-shadow: 0 0 10px gold;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span class="gold">🏆</span> Contador Dorado <span class="gold">🏆</span></h1>
            <p>Sistema de conteo persistente para Roblox</p>
        </div>
        
        <div id="stats" class="stats-grid">
            <!-- Las estadísticas se cargarán aquí -->
        </div>
        
        <button class="refresh-btn" onclick="loadStats()">🔄 Actualizar Estadísticas</button>
        
        <div class="instructions">
            <h2>📋 Instrucciones de Uso</h2>
            <p>Para usar este contador en tu juego de Roblox:</p>
            <ol>
                <li>Inserta este script en tu juego:</li>
                <pre><code>loadstring(game:HttpGet("https://TU_DOMINIO.workers.dev/api/script.js"))()</code></pre>
                <li>Endpoints disponibles:</li>
                <ul>
                    <li><code>/api/count.js</code> - Incrementar contador</li>
                    <li><code>/api/counter.js</code> - Obtener contador actual</li>
                    <li><code>/api/stats.js</code> - Estadísticas detalladas</li>
                    <li><code>/api/heartbeat.js</code> - Actualizar sesión</li>
                </ul>
            </ol>
        </div>
    </div>
    
    <script>
        async function loadStats() {
            try {
                const response = await fetch('/api/counter.js');
                const data = await response.json();
                
                document.getElementById('stats').innerHTML = \`
                    <div class="stat-card">
                        <div class="stat-label">Total Ejecuciones</div>
                        <div class="stat-value">\${data.total.toLocaleString()}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Ejecuciones Hoy</div>
                        <div class="stat-value">\${data.today.toLocaleString()}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Usuarios Online</div>
                        <div class="stat-value">\${data.online}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Pico Online</div>
                        <div class="stat-value">\${data.peakOnline}</div>
                    </div>
                \`;
            } catch (error) {
                console.error('Error cargando estadísticas:', error);
            }
        }
        
        // Cargar estadísticas al inicio y cada 30 segundos
        loadStats();
        setInterval(loadStats, 30000);
    </script>
</body>
</html>`;
            
            return new Response(indexHtml, {
                headers: {
                    "Content-Type": "text/html; charset=UTF-8"
                }
            });
        }
        
        // Endpoint no encontrado
        return new Response(JSON.stringify({
            error: 'Endpoint no encontrado',
            available: [
                '/api/count.js',
                '/api/counter.js', 
                '/api/stats.js',
                '/api/heartbeat.js',
                '/api/script.js'
            ]
        }), {
            status: 404,
            headers: { ...headers, 'Content-Type': 'application/json' }
        });
    }
};

export { CounterDurableObject };
