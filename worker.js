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
                    // Solo mantener sesiones como Map
                    sessions: new Map(Object.entries(saved.sessions || {})),
                    // Historial de online
                    hourlyOnline: new Map(Object.entries(saved.hourlyOnline || {})),
                };
            } else {
                this.stats = {
                    // Contadores básicos
                    total: 0,
                    today: 0,
                    online: 0,
                    
                    // Sesiones activas
                    sessions: new Map(),
                    
                    // Historial de online por hora
                    hourlyOnline: new Map(),
                    
                    // Picos
                    peakOnline: 0,
                    peakToday: 0,
                    
                    // Último reset
                    lastReset: new Date().toDateString(),
                    
                    // Total de requests
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
                    result = await getStats(this.stats); // Helper externo
                    break;
                    
                case '/heartbeat':
                    const { sessionId } = Object.fromEntries(url.searchParams);
                    result = await this.updateHeartbeat(sessionId);
                    break;
                    
                case '/online-history': // Nueva API simplificada
                    result = await this.getOnlineHistory();
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

    async incrementCounters({ sessionId }) {
        this.cleanupSessions();
        this.checkDailyReset();
        
        const now = new Date();
        const hour = now.getHours();
        const hourKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${hour}`;
        
        // Incrementar contadores
        this.stats.total++;
        this.stats.today++;
        this.stats.requestsCount++;
        
        // Actualizar peak del día
        if (this.stats.today > this.stats.peakToday) {
            this.stats.peakToday = this.stats.today;
        }
        
        // Registrar/actualizar sesión
        if (sessionId) {
            this.stats.sessions.set(sessionId, {
                lastHeartbeat: Date.now(),
                created: Date.now()
            });
            
            // Actualizar online
            this.stats.online = this.stats.sessions.size;
            
            // Actualizar peak online
            if (this.stats.online > this.stats.peakOnline) {
                this.stats.peakOnline = this.stats.online;
            }
            
            // Guardar historial de online para esta hora
            if (!this.stats.hourlyOnline.has(hourKey)) {
                this.stats.hourlyOnline.set(hourKey, {
                    hour: hourKey,
                    online: this.stats.online,
                    maxOnline: this.stats.online,
                    timestamp: now.toISOString()
                });
            } else {
                const hourStat = this.stats.hourlyOnline.get(hourKey);
                // Actualizar si el online actual es mayor
                if (this.stats.online > hourStat.maxOnline) {
                    hourStat.maxOnline = this.stats.online;
                    hourStat.online = this.stats.online; // Guardar el último valor también
                }
                hourStat.timestamp = now.toISOString();
            }
        }
        
        await this.saveStats();
        
        return {
            success: true,
            stats: {
                total: this.stats.total,
                today: this.stats.today,
                online: this.stats.online,
                peakOnline: this.stats.peakOnline,
                peakToday: this.stats.peakToday
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
            peakOnline: this.stats.peakOnline,
            peakToday: this.stats.peakToday,
            lastUpdate: new Date().toISOString()
        };
    }

    async getOnlineHistory() {
        this.cleanupSessions();
        
        const now = new Date();
        const hourlyData = [];
        
        // Obtener últimas 24 horas
        for (let i = 23; i >= 0; i--) {
            const hour = new Date(now);
            hour.setHours(now.getHours() - i);
            const hourKey = `${hour.getFullYear()}-${hour.getMonth()+1}-${hour.getDate()}-${hour.getHours()}`;
            const hourStat = this.stats.hourlyOnline.get(hourKey);
            
            hourlyData.push({
                hour: `${hour.getHours()}:00`,
                maxOnline: hourStat ? hourStat.maxOnline : 0,
                online: hourStat ? hourStat.online : 0,
                time: hourKey
            });
        }
        
        return {
            currentOnline: this.stats.online,
            peakOnline: this.stats.peakOnline,
            peakToday: this.stats.peakToday,
            hourly: hourlyData,
            lastUpdate: now.toISOString()
        };
    }

    cleanupSessions() {
        const now = Date.now();
        const sessionsToDelete = [];
        
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            // 5 minutos sin heartbeat = sesión muerta
            if (now - session.lastHeartbeat > 5 * 60 * 1000) {
                sessionsToDelete.push(sessionId);
            }
        }
        
        // Eliminar sesiones muertas
        for (const sessionId of sessionsToDelete) {
            this.stats.sessions.delete(sessionId);
        }
        
        // Actualizar contador de online
        this.stats.online = this.stats.sessions.size;
        
        // Si eliminamos sesiones, guardar cambios
        if (sessionsToDelete.length > 0) {
            this.saveStats().catch(console.error);
        }
    }

    checkDailyReset() {
        const today = new Date().toDateString();
        if (this.stats.lastReset !== today) {
            this.stats.today = 0;
            this.stats.peakToday = 0;
            this.stats.lastReset = today;
            this.saveStats().catch(console.error);
        }
    }

    async updateHeartbeat(sessionId) {
        if (!sessionId) {
            return { success: false, online: this.stats.online };
        }
        
        this.cleanupSessions();
        
        const now = Date.now();
        
        if (this.stats.sessions.has(sessionId)) {
            // Actualizar sesión existente
            const session = this.stats.sessions.get(sessionId);
            session.lastHeartbeat = now;
            
            await this.saveStats();
            return { 
                success: true, 
                online: this.stats.online
            };
        } else {
            // Crear nueva sesión
            this.stats.sessions.set(sessionId, {
                lastHeartbeat: now,
                created: now
            });
            
            this.stats.online = this.stats.sessions.size;
            
            if (this.stats.online > this.stats.peakOnline) {
                this.stats.peakOnline = this.stats.online;
            }
            
            await this.saveStats();
            return { 
                success: true, 
                online: this.stats.online
            };
        }
    }

    async saveStats() {
        try {
            // Convertir Maps a objetos para almacenamiento
            const toSave = {
                total: this.stats.total,
                today: this.stats.today,
                online: this.stats.online,
                peakOnline: this.stats.peakOnline,
                peakToday: this.stats.peakToday,
                lastReset: this.stats.lastReset,
                requestsCount: this.stats.requestsCount,
                sessions: Object.fromEntries(this.stats.sessions),
                hourlyOnline: Object.fromEntries(this.stats.hourlyOnline)
            };
            
            await this.storage.put('stats', toSave);
            return true;
        } catch (error) {
            console.error('Error guardando stats:', error);
            return false;
        }
    }
}

// Helper externo para stats (para evitar el error de las uniqueUsers)
function getStats(stats) {
    // Limpiar sesiones si es necesario
    const now = Date.now();
    let online = stats.online;
    
    // Calcular últimas 12 horas
    const hourlyData = [];
    const now_date = new Date();
    
    for (let i = 11; i >= 0; i--) {
        const hour = new Date(now_date);
        hour.setHours(now_date.getHours() - i);
        const hourKey = `${hour.getFullYear()}-${hour.getMonth()+1}-${hour.getDate()}-${hour.getHours()}`;
        const hourStat = stats.hourlyOnline.get(hourKey);
        
        hourlyData.push({
            hour: `${hour.getHours()}:00`,
            maxOnline: hourStat ? hourStat.maxOnline : 0,
            online: hourStat ? hourStat.online : 0
        });
    }
    
    return {
        summary: {
            total: stats.total,
            today: stats.today,
            online: online,
            peakOnline: stats.peakOnline,
            peakToday: stats.peakToday,
            requestsCount: stats.requestsCount,
            lastReset: stats.lastReset,
            activeSessions: stats.sessions.size
        },
        hourly: hourlyData,
        lastUpdate: new Date().toISOString()
    };
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
        
        // Manejar endpoints
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
        
        if (path === '/api/online-history' || path === '/api/online-history.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/online-history';
            return obj.fetch(newUrl);
        }
        
        // Script simplificado para Roblox
        if (path === '/api/script' || path === '/api/script.js') {
            const baseUrl = `https://${url.hostname}`;
            
            const script = `-- CONTADOR SIMPLE
local HttpService = game:GetService("HttpService")
local player = game.Players.LocalPlayer

local API = "${baseUrl}/api"
local sessionId = "S_" .. player.UserId .. "_" .. math.random(1000,9999)

print("📊 CONTADOR INICIADO")

local function sendRequest(endpoint, params)
    local url = API .. endpoint .. "?"
    for k, v in pairs(params or {}) do
        url = url .. k .. "=" .. HttpService:UrlEncode(tostring(v)) .. "&"
    end
    
    local success, result = pcall(function()
        local req = HttpService:RequestAsync({
            Url = url:sub(1, -2),
            Method = "GET",
            Timeout = 5
        })
        return req.Body
    end)
    return success and result or nil
end

-- Registro inicial
local response = sendRequest("count.js", {
    sessionId = sessionId
})

if response then
    local success, data = pcall(function()
        return HttpService:JSONDecode(response)
    end)
    if success and data.stats then
        print("✅ Conectado - Online: " .. data.stats.online)
    end
end

-- Heartbeat
while true do
    task.wait(30)
    local result = sendRequest("heartbeat.js", {
        sessionId = sessionId
    })
    if result then
        local success, data = pcall(function()
            return HttpService:JSONDecode(result)
        end)
        if success and data then
            -- Silencioso, solo mantiene conexión
        end
    end
end`;
            
            return new Response(script, {
                headers: {
                    'Content-Type': 'text/plain',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        // Página principal
        if (path === "/") {
            return new Response(JSON.stringify({
                message: "Contador Simple API",
                endpoints: {
                    count: "/api/count.js?sessionId=123",
                    counter: "/api/counter.js",
                    stats: "/api/stats.js",
                    heartbeat: "/api/heartbeat.js?sessionId=123",
                    "online-history": "/api/online-history.js",
                    script: "/api/script.js"
                }
            }), {
                headers: { ...headers, 'Content-Type': 'application/json' }
            });
        }
        
        return new Response(JSON.stringify({
            error: 'Endpoint no encontrado'
        }), {
            status: 404,
            headers: { ...headers, 'Content-Type': 'application/json' }
        });
    }
};

export { ContadorStats };
