// Cambia el nombre de la clase a ContadorStats
class ContadorStats {
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

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json'
        };

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

    async incrementCounters({ userId, playerName, sessionId, gameId }) {
        this.cleanupSessions();
        this.checkDailyReset();
        
        const now = new Date();
        const today = now.toDateString();
        const hourKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${now.getHours()}`;
        
        this.stats.total++;
        this.stats.today++;
        this.stats.requestsCount++;
        
        if (this.stats.today > this.stats.peakToday) {
            this.stats.peakToday = this.stats.today;
        }
        
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

    cleanupSessions() {
        const now = Date.now();
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            if (now - session.lastHeartbeat > 45000) {
                this.stats.sessions.delete(sessionId);
            }
        }
        this.stats.online = this.stats.sessions.size;
    }

    checkDailyReset() {
        const today = new Date().toDateString();
        if (this.stats.lastReset !== today) {
            this.stats.today = 0;
            this.stats.peakToday = 0;
            this.stats.lastReset = today;
        }
    }

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

    async saveStats() {
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
        
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        };

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
        local jsonSuccess, data = pcall(function()
            return game:GetService("HttpService"):JSONDecode(result)
        end)
        if jsonSuccess then
            print("📊 Total: " .. tostring(data.stats.total))
            print("👥 Online: " .. tostring(data.stats.online))
        end
    end
end

local function heartbeat()
    pcall(function()
        game:GetService("HttpService"):RequestAsync{
            Url = API .. "/heartbeat.js?sessionId=" .. sessionId .. "&userId=" .. player.UserId,
            Method = "GET"
        }
    end)
end

register()

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
        
        // Si tienes el index.html separado, asegúrate de servirlo correctamente
        // Esta parte dependerá de cómo tienes configurado tu proyecto
        if (path === "/" || path === "/index.html") {
            // Aquí deberías devolver tu archivo index.html
            // Si está en la carpeta public, puedes leerlo de allí
            // O si usas [assets] en wrangler.toml, debería servirse automáticamente
            return new Response("Página principal - Contador Dorado", {
                headers: {
                    "Content-Type": "text/html; charset=UTF-8"
                }
            });
        }
        
        return new Response(JSON.stringify({
            error: 'Endpoint no encontrado',
            available: [
                '/api/count.js',
                '/api/counter.js', 
                '/api/stats.js',
                '/api/heartbeat.js',
                '/api/script.js',
                '/'
            ]
        }), {
            status: 404,
            headers: { ...headers, 'Content-Type': 'application/json' }
        });
    }
};

// Exporta la clase con el nombre CORRECTO: ContadorStats
export { ContadorStats };
