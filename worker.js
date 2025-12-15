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
        const hour = now.getHours();
        const hourKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${hour}`;
        
        this.stats.total++;
        this.stats.today++;
        this.stats.requestsCount++;
        
        if (this.stats.today > this.stats.peakToday) {
            this.stats.peakToday = this.stats.today;
        }
        
        // Actualizar estadísticas por hora
        if (!this.stats.hourlyStats.has(hourKey)) {
            this.stats.hourlyStats.set(hourKey, {
                hour: hourKey,
                count: 1,
                timestamp: now.toISOString()
            });
        } else {
            const hourStat = this.stats.hourlyStats.get(hourKey);
            hourStat.count++;
            hourStat.timestamp = now.toISOString();
        }
        
        // Actualizar estadísticas diarias
        if (!this.stats.dailyStats.has(today)) {
            this.stats.dailyStats.set(today, {
                date: today,
                count: 1,
                uniqueUsers: new Set([userId])
            });
        } else {
            const dayStat = this.stats.dailyStats.get(today);
            dayStat.count++;
            dayStat.uniqueUsers.add(userId);
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
        
        // Obtener últimas 12 horas
        const now = new Date();
        const hourlyData = [];
        for (let i = 11; i >= 0; i--) {
            const hour = new Date(now);
            hour.setHours(now.getHours() - i);
            const hourKey = `${hour.getFullYear()}-${hour.getMonth()+1}-${hour.getDate()}-${hour.getHours()}`;
            const hourStat = this.stats.hourlyStats.get(hourKey);
            
            hourlyData.push({
                hour: `${hour.getHours()}:00`,
                count: hourStat ? hourStat.count : 0,
                date: hourKey
            });
        }
        
        // Obtener últimos 7 días
        const dailyData = [];
        for (let i = 6; i >= 0; i--) {
            const day = new Date(now);
            day.setDate(now.getDate() - i);
            const dayKey = day.toDateString();
            const dayStat = this.stats.dailyStats.get(dayKey);
            
            dailyData.push({
                date: dayKey.substring(4, 10), // Formato corto: "Dec 15"
                count: dayStat ? dayStat.count : 0,
                unique: dayStat ? dayStat.uniqueUsers.size : 0
            });
        }
        
        // Calcular estadísticas por hora actual
        const currentHour = new Date();
        currentHour.setMinutes(0, 0, 0);
        const currentHourKey = `${currentHour.getFullYear()}-${currentHour.getMonth()+1}-${currentHour.getDate()}-${currentHour.getHours()}`;
        const currentHourStat = this.stats.hourlyStats.get(currentHourKey);
        
        return {
            summary: {
                total: this.stats.total,
                today: this.stats.today,
                online: this.stats.online,
                unique: this.stats.uniqueUsers.size,
                peakOnline: this.stats.peakOnline,
                peakToday: this.stats.peakToday,
                requestsCount: this.stats.requestsCount,
                lastReset: this.stats.lastReset
            },
            hourly: hourlyData,
            daily: dailyData,
            currentHour: {
                count: currentHourStat ? currentHourStat.count : 0,
                hour: currentHourKey
            },
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
        // Convertir Maps a objetos para almacenamiento
        const toSave = {
            ...this.stats,
            uniqueUsers: Object.fromEntries(this.stats.uniqueUsers),
            sessions: Object.fromEntries(this.stats.sessions),
            hourlyStats: Object.fromEntries(this.stats.hourlyStats),
            dailyStats: Object.fromEntries(this.stats.dailyStats.entries())
        };
        
        // Convertir Sets a arrays para dailyStats
        for (const [key, value] of Object.entries(toSave.dailyStats || {})) {
            if (value.uniqueUsers && value.uniqueUsers instanceof Set) {
                value.uniqueUsers = Array.from(value.uniqueUsers);
            }
        }
        
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

        const id = env.CONTADOR_STATS.idFromName('main');
        const obj = env.CONTADOR_STATS.get(id);
        
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
        
        // Script para Roblox - ACTUALIZADO para que funcione con tu HTML
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
            print("🎯 Tus ejecuciones: " .. tostring(data.stats.yourTotal))
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

-- Iniciar contador
register()

-- Heartbeat cada 30s para mantener sesión activa
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
        
        // Servir el index.html
        if (path === "/" || path === "/index.html") {
            // Si tienes el HTML en una carpeta separada, cárgalo desde allí
            // O si está en la misma ubicación, usa tu HTML
            try {
                // Reemplaza esto con la ruta correcta a tu HTML
                const html = `TU HTML AQUÍ - PERO MEJOR SÍRVELO DESDE TU CARPETA PUBLIC`;
                return new Response(html, {
                    headers: {
                        "Content-Type": "text/html; charset=UTF-8"
                    }
                });
            } catch (error) {
                return new Response(`<h1>Contador Dorado 🏆</h1><p>Sistema funcionando correctamente</p><p><a href="/api/counter.js">Ver estadísticas</a></p>`, {
                    headers: {
                        "Content-Type": "text/html; charset=UTF-8"
                    }
                });
            }
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

// Exporta la clase del Durable Object
export { ContadorStats };
