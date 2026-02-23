class ContadorStats {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env; // Guardar env para usarlo después

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
                    requestsCount: 0,
                    peakOnlineNotified: 0
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
            // Log del error completo para debugging
            console.error('Error en Durable Object:', error);
            
            return new Response(JSON.stringify({ 
                error: 'Error interno',
                message: error.message,
                stack: error.stack // Solo para debugging, quitar en producción
            }), {
                status: 500,
                headers
            });
        }
    }

    // Función para enviar notificación a webhook
    async notifyWebhook(peakOnline) {
        // Verificar que env existe
        if (!this.env) {
            console.log('⚠️ this.env no está disponible en el Durable Object');
            return false;
        }

        const webhookUrl = this.env.WEBHOOKONLINE_URL;
        
        if (!webhookUrl) {
            console.log('⚠️ No webhook URL configured in secrets');
            return false;
        }

        const message = {
            content: null,
            embeds: [{
                title: '🏆 online',
                description: `Se ha alcanzado un nuevo máximo de **${peakOnline}** usuarios conectados simultáneamente.`,
                color: 0xFFD700,
                fields: [
                    {
                        name: '📊 Estadísticas actuales',
                        value: `Total ejecuciones: ${this.stats.total}\nHoy: ${this.stats.today}\nUsuarios únicos: ${this.stats.uniqueUsers.size}`,
                        inline: true
                    },
                    {
                        name: '⏰ Timestamp',
                        value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'zl online'
                }
            }]
        };

        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message)
            });

            if (response.ok) {
                console.log(`✅ Webhook enviado: Nuevo récord de ${peakOnline} usuarios online`);
                return true;
            } else {
                const errorText = await response.text();
                console.error(`❌ Error enviando webhook: ${response.status} - ${errorText}`);
                return false;
            }
        } catch (error) {
            console.error('❌ Error en webhook:', error.message);
            return false;
        }
    }

    async incrementCounters({ userId, playerName, sessionId, gameId }) {
        try {
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
            
            // Actualizar sesión
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
                
                // Verificar nuevo récord
                if (this.stats.online > this.stats.peakOnline) {
                    const oldPeak = this.stats.peakOnline;
                    this.stats.peakOnline = this.stats.online;
                    
                    console.log(`🏆 Nuevo récord! ${oldPeak} -> ${this.stats.peakOnline}`);
                    
                    // Notificar solo si es un récord significativamente mayor
                    if (this.stats.peakOnline > this.stats.peakOnlineNotified) {
                        // Usar waitUntil para no bloquear la respuesta
                        this.state.waitUntil(this.notifyWebhook(this.stats.peakOnline));
                        this.stats.peakOnlineNotified = this.stats.peakOnline;
                    }
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
                    yourTotal: this.stats.uniqueUsers.get(userKey)?.totalExecutions || 1,
                    peakOnline: this.stats.peakOnline
                },
                timestamp: now.toISOString()
            };
        } catch (error) {
            console.error('Error en incrementCounters:', error);
            throw error; // Re-lanzar para que el fetch lo maneje
        }
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
            lastUpdate: new Date().toISOString(),
            sessionsCount: this.stats.sessions.size
        };
    }

    async getDetailedStats() {
        this.cleanupSessions();
        this.checkDailyReset();
        
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
        
        const dailyData = [];
        for (let i = 6; i >= 0; i--) {
            const day = new Date(now);
            day.setDate(now.getDate() - i);
            const dayKey = day.toDateString();
            const dayStat = this.stats.dailyStats.get(dayKey);
            
            dailyData.push({
                date: dayKey.substring(4, 10),
                count: dayStat ? dayStat.count : 0,
                unique: dayStat ? dayStat.uniqueUsers.size : 0
            });
        }
        
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
                activeSessions: this.stats.sessions.size,
                peakOnlineNotified: this.stats.peakOnlineNotified
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
        const sessionsToDelete = [];
        
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            if (now - session.lastHeartbeat > 15 * 60 * 1000) {
                sessionsToDelete.push(sessionId);
            }
        }
        
        for (const sessionId of sessionsToDelete) {
            this.stats.sessions.delete(sessionId);
        }
        
        this.stats.online = this.stats.sessions.size;
        
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

    async updateHeartbeat(sessionId, userId) {
        try {
            if (!sessionId || !userId) {
                return { success: false, online: this.stats.online };
            }
            
            this.cleanupSessions();
            
            const now = Date.now();
            
            if (this.stats.sessions.has(sessionId)) {
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
                let userSessionFound = false;
                for (const [sid, session] of this.stats.sessions.entries()) {
                    if (session.userId === userId) {
                        session.lastHeartbeat = now;
                        session.lastActivity = now;
                        userSessionFound = true;
                        break;
                    }
                }
                
                if (!userSessionFound) {
                    this.stats.sessions.set(sessionId, {
                        userId,
                        playerName: `User_${userId}`,
                        lastHeartbeat: now,
                        created: now,
                        lastActivity: now
                    });
                    
                    this.stats.online = this.stats.sessions.size;
                    
                    if (this.stats.online > this.stats.peakOnline) {
                        const oldPeak = this.stats.peakOnline;
                        this.stats.peakOnline = this.stats.online;
                        
                        console.log(`🏆 Nuevo récord desde heartbeat! ${oldPeak} -> ${this.stats.peakOnline}`);
                        
                        if (this.stats.peakOnline > this.stats.peakOnlineNotified) {
                            this.state.waitUntil(this.notifyWebhook(this.stats.peakOnline));
                            this.stats.peakOnlineNotified = this.stats.peakOnline;
                        }
                    }
                }
                
                await this.saveStats();
                return { 
                    success: true, 
                    online: this.stats.online,
                    message: userSessionFound ? "Sesión del usuario actualizada" : "Nueva sesión creada"
                };
            }
        } catch (error) {
            console.error('Error en updateHeartbeat:', error);
            throw error;
        }
    }

    async saveStats() {
        try {
            const toSave = {
                ...this.stats,
                uniqueUsers: Object.fromEntries(this.stats.uniqueUsers),
                sessions: Object.fromEntries(this.stats.sessions),
                hourlyStats: Object.fromEntries(this.stats.hourlyStats),
                dailyStats: Object.fromEntries(this.stats.dailyStats.entries())
            };
            
            for (const [key, value] of Object.entries(toSave.dailyStats || {})) {
                if (value.uniqueUsers && value.uniqueUsers instanceof Set) {
                    value.uniqueUsers = Array.from(value.uniqueUsers);
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

        try {
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
            
            if (path === '/api/script' || path === '/api/script.js') {
                const baseUrl = `https://${url.hostname}`;
                
                const script = `-- 🏆 CONTADOR DORADO - SISTEMA MEJORADO 🏆
-- URL: ${baseUrl}

local HttpService = game:GetService("HttpService")
local player = game.Players.LocalPlayer

local API = "${baseUrl}/api"
local sessionId = "S_" .. player.UserId .. "_" .. math.random(1000,9999)

print("🏆 CONTADOR DORADO - SISTEMA MEJORADO")

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

-- Registrar ejecución INICIAL
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
    
    local jsonSuccess, data = pcall(function()
        return HttpService:JSONDecode(response)
    end)
    
    if jsonSuccess and data.stats then
        print("📊 Total: " .. data.stats.total)
        print("🎯 Hoy: " .. data.stats.today)
        print("👥 Online: " .. data.stats.online)
        print("⭐ Únicos: " .. data.stats.unique)
        print("🔥 Tuyas: " .. data.stats.yourTotal)
        print("🏆 Récord online: " .. (data.stats.peakOnline or "N/A"))
    end
else
    print("⚠️ No se pudo registrar ejecución inicial")
end

-- Obtener contador actual
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
        print("   Récord online: " .. data.peakOnline)
    end
else
    print("⚠️ No se pudo obtener contador")
end

-- Sistema de heartbeat
print("\\n💓 Heartbeat iniciado (cada 25 segundos)")
local heartbeatCount = 0

while true do
    task.wait(25)
    
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
            if heartbeatCount % 10 == 0 then
                print("💗 Heartbeat #" .. heartbeatCount .. " - Online: " .. data.online)
            end
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
            
            if (path === '/') {
                return new Response(JSON.stringify({
                    message: "Contador Dorado API",
                    endpoints: {
                        counter: "/api/counter.js",
                        stats: "/api/stats.js",
                        script: "/api/script.js"
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
                    '/'
                ]
            }), {
                status: 404,
                headers: { ...headers, 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('Error en worker principal:', error);
            
            return new Response(JSON.stringify({
                error: 'Error interno del servidor',
                message: error.message
            }), {
                status: 500,
                headers: { ...headers, 'Content-Type': 'application/json' }
            });
        }
    }
};

export { ContadorStats };
