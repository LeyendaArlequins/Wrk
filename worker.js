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
                totalExecutions: 1,
                sessions: [sessionId]
            });
        } else {
            const user = this.stats.uniqueUsers.get(userKey);
            user.totalExecutions++;
            user.lastSeen = now.toISOString();
            if (!user.sessions.includes(sessionId)) {
                user.sessions.push(sessionId);
            }
        }
        
        // MEJORA: Siempre crear/actualizar sesión incluso si ya existe
        if (sessionId) {
            this.stats.sessions.set(sessionId, {
                userId,
                playerName: playerName || `User_${userId}`,
                lastHeartbeat: Date.now(),
                created: Date.now(),
                gameId,
                lastActivity: Date.now()
            });
            
            // Actualizar contador de online
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
        // Siempre limpiar sesiones antes de devolver datos
        this.cleanupSessions();
        this.checkDailyReset();
        
        return {
            total: this.stats.total,
            today: this.stats.today,
            online: this.stats.online,
            unique: this.stats.uniqueUsers.size,
            peakOnline: this.stats.peakOnline,
            peakToday: this.stats.peakToday,
            lastUpdate: new Date().toISOString(),
            sessionsCount: this.stats.sessions.size // Para debug
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
                lastReset: this.stats.lastReset,
                activeSessions: this.stats.sessions.size
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

    // MEJORA: Aumentar tiempo de limpieza a 90 segundos
    cleanupSessions() {
        const now = Date.now();
        const sessionsToDelete = [];
        
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            // 90 segundos sin heartbeat = sesión muerta
            if (now - session.lastHeartbeat > 90000) {
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

    // MEJORA: Manejo mejorado de heartbeat
    async updateHeartbeat(sessionId, userId) {
        if (!sessionId || !userId) {
            return { success: false, online: this.stats.online };
        }
        
        this.cleanupSessions();
        
        const now = Date.now();
        
        if (this.stats.sessions.has(sessionId)) {
            // Actualizar sesión existente
            const session = this.stats.sessions.get(sessionId);
            session.lastHeartbeat = now;
            session.lastActivity = now;
            
            await this.saveStats();
            return { 
                success: true, 
                online: this.stats.online,
                message: "Heartbeat actualizado"
            };
        } else {
            // Sesión no encontrada, crear una nueva si userId coincide
            // Buscar si el usuario tiene otra sesión activa
            let userSessionFound = false;
            for (const [sid, session] of this.stats.sessions.entries()) {
                if (session.userId === userId) {
                    // Actualizar sesión existente del usuario
                    session.lastHeartbeat = now;
                    session.lastActivity = now;
                    userSessionFound = true;
                    break;
                }
            }
            
            if (!userSessionFound) {
                // Crear nueva sesión
                this.stats.sessions.set(sessionId, {
                    userId,
                    playerName: `User_${userId}`,
                    lastHeartbeat: now,
                    created: now,
                    lastActivity: now
                });
                
                this.stats.online = this.stats.sessions.size;
                
                if (this.stats.online > this.stats.peakOnline) {
                    this.stats.peakOnline = this.stats.online;
                }
            }
            
            await this.saveStats();
            return { 
                success: true, 
                online: this.stats.online,
                message: userSessionFound ? "Sesión del usuario actualizada" : "Nueva sesión creada"
            };
        }
    }

    async saveStats() {
        try {
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
            
            // Convertir arrays de sesiones en usuarios
            for (const [key, user] of Object.entries(toSave.uniqueUsers || {})) {
                if (user.sessions && Array.isArray(user.sessions)) {
                    // Mantener como array
                }
            }
            
            await this.storage.put('stats', toSave);
            return true;
        } catch (error) {
            console.error('Error guardando stats:', error);
            return false;
        }
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
        
        // Manejar ambas versiones: con y sin .js
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
        
        // Script para Roblox - MEJORADO
        if (path === '/api/script' || path === '/api/script.js') {
            const baseUrl = `https://${url.hostname}`;
            
            const script = `-- 🏆 CONTADOR DORADO - SISTEMA MEJORADO 🏆
-- Estado PERSISTENTE con mejor manejo de sesiones
-- URL: ${baseUrl}

local HttpService = game:GetService("HttpService")
local player = game.Players.LocalPlayer

local API = "${baseUrl}/api"
local sessionId = "S_" .. player.UserId .. "_" .. math.random(1000,9999)

print("🏆 CONTADOR DORADO - SISTEMA MEJORADO")

-- Función para enviar requests con mejor manejo de errores
local function sendRequest(endpoint, params)
    local url = API .. endpoint .. "?"
    
    for k, v in pairs(params or {}) do
        url = url .. k .. "=" .. HttpService:UrlEncode(tostring(v)) .. "&"
    end
    
    local success, result = pcall(function()
        local req = HttpService:RequestAsync({
            Url = url:sub(1, -2),
            Method = "GET",
            Headers = {
                ["Cache-Control"] = "no-cache"
            }
        })
        return req.Body
    end)
    
    if success then
        return result
    else
        print("⚠️ Error en request: " .. tostring(result))
        return nil
    end
end

-- 1. Registrar ejecución INICIAL
print("📤 Registrando ejecución inicial...")
local response = sendRequest("count.js", {
    userId = player.UserId,
    playerName = player.Name,
    sessionId = sessionId,
    gameId = game.GameId,
    time = os.time()
})

if response then
    print("✅ Ejecución registrada")
    
    -- Parsear respuesta
    local jsonSuccess, data = pcall(function()
        return HttpService:JSONDecode(response)
    end)
    
    if jsonSuccess and data.stats then
        print("📊 Total: " .. data.stats.total)
        print("🎯 Hoy: " .. data.stats.today)
        print("👥 Online: " .. data.stats.online)
        print("⭐ Únicos: " .. data.stats.unique)
        print("🔥 Tuyas: " .. data.stats.yourTotal)
    end
else
    print("⚠️ No se pudo registrar ejecución inicial")
end

-- 2. Obtener contador actual (para verificar)
task.wait(2)
print("\\n📡 Obteniendo contador actual...")
local counter = sendRequest("counter.js", {})
if counter then
    local jsonSuccess, data = pcall(function()
        return HttpService:JSONDecode(counter)
    end)
    
    if jsonSuccess then
        print("📈 CONTADOR ACTUAL:")
        print("   Total: " .. data.total)
        print("   Hoy: " .. data.today)
        print("   Online: " .. data.online)
        print("   Únicos: " .. data.unique)
        print("   Sesiones activas: " .. tostring(data.sessionsCount or "N/A"))
    end
else
    print("⚠️ No se pudo obtener contador")
end

-- 3. Sistema de heartbeat MEJORADO
print("\\n💓 Heartbeat mejorado iniciado (cada 25 segundos)")
local heartbeatCount = 0
local lastHeartbeatSuccess = true

while true do
    task.wait(25) -- Reducido a 25 segundos para mayor seguridad
    
    heartbeatCount = heartbeatCount + 1
    
    local result = sendRequest("heartbeat.js", {
        sessionId = sessionId,
        userId = player.UserId
    })
    
    if result then
        local jsonSuccess, data = pcall(function()
            return HttpService:JSONDecode(result)
        end)
        
        if jsonSuccess and data.success then
            if not lastHeartbeatSuccess then
                print("✅ Heartbeat restaurado - Online: " .. tostring(data.online))
                lastHeartbeatSuccess = true
            end
            
            -- Mostrar progreso cada 10 heartbeats
            if heartbeatCount % 10 == 0 then
                print("💗 Heartbeat #" .. heartbeatCount .. " - Online: " .. data.online)
            end
        else
            if lastHeartbeatSuccess then
                print("⚠️ Heartbeat falló (intentando reconectar...)")
                lastHeartbeatSuccess = false
            end
        end
    else
        if lastHeartbeatSuccess then
            print("⚠️ No se pudo enviar heartbeat")
            lastHeartbeatSuccess = false
        end
    end
    
    -- Intentar reconexión completa cada 60 heartbeats (~25 minutos)
    if heartbeatCount % 60 == 0 then
        print("🔄 Reconexión programada...")
        local reconnect = sendRequest("count.js", {
            userId = player.UserId,
            playerName = player.Name,
            sessionId = sessionId,
            gameId = game.GameId,
            reconnect = true
        })
        
        if reconnect then
            print("✅ Reconexión exitosa")
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
        
        // Ruta para debug
        if (path === '/api/debug') {
            const id = env.CONTADOR_STATS.idFromName('main');
            const obj = env.CONTADOR_STATS.get(id);
            const newUrl = new URL(url);
            newUrl.pathname = '/debug';
            return obj.fetch(newUrl);
        }
        
        // Si el path es solo "/", servir página principal
        if (path === "/") {
            return new Response(JSON.stringify({
                message: "Contador Dorado API",
                endpoints: {
                    counter: "/api/counter.js",
                    stats: "/api/stats.js",
                    script: "/api/script.js",
                    debug: "/api/debug"
                }
            }), {
                headers: { ...headers, 'Content-Type': 'application/json' }
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
                '/api/debug',
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
