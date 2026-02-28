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
                    onlineHistory: new Map(Object.entries(saved.onlineHistory || {})), // NUEVO
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
                    onlineHistory: new Map(), // NUEVO: Historial de online por minuto/hora
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
                    
                case '/online-history': // NUEVA API
                    result = await this.getOnlineHistory();
                    break;
                    
                case '/player-time': // NUEVA API para tiempo de jugadores
                    const { userId: playerUserId } = Object.fromEntries(url.searchParams);
                    result = await this.getPlayerActiveTime(playerUserId);
                    break;
                    
                case '/active-players': // NUEVA API para lista de jugadores activos con su tiempo
                    result = await this.getActivePlayersWithTime();
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
        const minute = now.getMinutes();
        const hourKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${hour}`;
        const minuteKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${hour}-${minute}`;
        
        this.stats.total++;
        this.stats.today++;
        this.stats.requestsCount++;
        
        if (this.stats.today > this.stats.peakToday) {
            this.stats.peakToday = this.stats.today;
        }
        
        // MODIFICADO: Registrar online por hora en lugar de ejecuciones
        if (!this.stats.hourlyStats.has(hourKey)) {
            this.stats.hourlyStats.set(hourKey, {
                hour: hourKey,
                maxOnline: this.stats.online, // Guardar máximo online en esa hora
                avgOnline: this.stats.online,
                samples: 1,
                timestamp: now.toISOString()
            });
        } else {
            const hourStat = this.stats.hourlyStats.get(hourKey);
            // Actualizar máximo online
            if (this.stats.online > hourStat.maxOnline) {
                hourStat.maxOnline = this.stats.online;
            }
            // Actualizar promedio
            hourStat.avgOnline = Math.round((hourStat.avgOnline * hourStat.samples + this.stats.online) / (hourStat.samples + 1));
            hourStat.samples++;
            hourStat.timestamp = now.toISOString();
        }
        
        // NUEVO: Registrar historial de online por minuto
        if (!this.stats.onlineHistory.has(minuteKey)) {
            this.stats.onlineHistory.set(minuteKey, {
                minute: minuteKey,
                online: this.stats.online,
                timestamp: now.toISOString()
            });
            
            // Limpiar historial antiguo (mantener últimas 24 horas)
            this.cleanupOnlineHistory();
        }
        
        // Actualizar estadísticas diarias
        if (!this.stats.dailyStats.has(today)) {
            this.stats.dailyStats.set(today, {
                date: today,
                count: 1,
                uniqueUsers: new Set([userId]),
                maxOnline: this.stats.online,
                avgOnline: this.stats.online
            });
        } else {
            const dayStat = this.stats.dailyStats.get(today);
            dayStat.count++;
            dayStat.uniqueUsers.add(userId);
            // Actualizar máximo online del día
            if (this.stats.online > dayStat.maxOnline) {
                dayStat.maxOnline = this.stats.online;
            }
            // Actualizar promedio online del día
            dayStat.avgOnline = Math.round((dayStat.avgOnline + this.stats.online) / 2);
        }
        
        const userKey = `user_${userId}`;
        const nowTime = Date.now();
        
        if (!this.stats.uniqueUsers.has(userKey)) {
            this.stats.uniqueUsers.set(userKey, {
                userId,
                playerName: playerName || `User_${userId}`,
                firstSeen: now.toISOString(),
                lastSeen: now.toISOString(),
                totalExecutions: 1,
                totalActiveTime: 0, // NUEVO: Tiempo total activo en ms
                currentSessionStart: nowTime, // NUEVO: Inicio de sesión actual
                sessions: [sessionId]
            });
        } else {
            const user = this.stats.uniqueUsers.get(userKey);
            user.totalExecutions++;
            user.lastSeen = now.toISOString();
            if (!user.sessions.includes(sessionId)) {
                user.sessions.push(sessionId);
            }
            // Si no tenía sesión activa, iniciar nueva
            if (!user.currentSessionStart) {
                user.currentSessionStart = nowTime;
            }
        }
        
        if (sessionId) {
            this.stats.sessions.set(sessionId, {
                userId,
                playerName: playerName || `User_${userId}`,
                lastHeartbeat: Date.now(),
                created: Date.now(),
                gameId,
                lastActivity: Date.now(),
                totalActiveTime: 0 // NUEVO: Tiempo activo en esta sesión
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
                yourTotal: this.stats.uniqueUsers.get(userKey)?.totalExecutions || 1,
                yourActiveTime: this.stats.uniqueUsers.get(userKey)?.totalActiveTime || 0
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
            lastUpdate: new Date().toISOString(),
            sessionsCount: this.stats.sessions.size
        };
    }

    async getDetailedStats() {
        this.cleanupSessions();
        this.checkDailyReset();
        
        // Obtener últimas 24 horas (por hora) - AHORA CON DATOS DE ONLINE
        const now = new Date();
        const hourlyData = [];
        for (let i = 23; i >= 0; i--) {
            const hour = new Date(now);
            hour.setHours(now.getHours() - i);
            const hourKey = `${hour.getFullYear()}-${hour.getMonth()+1}-${hour.getDate()}-${hour.getHours()}`;
            const hourStat = this.stats.hourlyStats.get(hourKey);
            
            hourlyData.push({
                hour: `${hour.getHours()}:00`,
                maxOnline: hourStat ? hourStat.maxOnline : 0,
                avgOnline: hourStat ? hourStat.avgOnline : 0,
                samples: hourStat ? hourStat.samples : 0,
                date: hourKey
            });
        }
        
        // Obtener últimos 30 minutos para datos en tiempo real
        const minuteData = [];
        for (let i = 29; i >= 0; i--) {
            const minute = new Date(now);
            minute.setMinutes(now.getMinutes() - i);
            const minuteKey = `${minute.getFullYear()}-${minute.getMonth()+1}-${minute.getDate()}-${minute.getHours()}-${minute.getMinutes()}`;
            const minuteStat = this.stats.onlineHistory.get(minuteKey);
            
            minuteData.push({
                time: `${minute.getHours()}:${minute.getMinutes().toString().padStart(2, '0')}`,
                online: minuteStat ? minuteStat.online : this.stats.online,
                timestamp: minuteStat ? minuteStat.timestamp : now.toISOString()
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
                date: dayKey.substring(4, 10),
                count: dayStat ? dayStat.count : 0,
                unique: dayStat ? dayStat.uniqueUsers.size : 0,
                maxOnline: dayStat ? dayStat.maxOnline : 0,
                avgOnline: dayStat ? dayStat.avgOnline : 0
            });
        }
        
        // Estadísticas de la hora actual
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
            minuteRealtime: minuteData,
            daily: dailyData,
            currentHour: {
                maxOnline: currentHourStat ? currentHourStat.maxOnline : this.stats.online,
                avgOnline: currentHourStat ? currentHourStat.avgOnline : this.stats.online,
                samples: currentHourStat ? currentHourStat.samples : 0,
                hour: currentHourKey
            },
            lastUpdate: new Date().toISOString()
        };
    }

    // NUEVA: API para obtener historial de online
    async getOnlineHistory() {
        this.cleanupSessions();
        
        const now = new Date();
        const history = [];
        
        // Últimas 24 horas por hora (resumido)
        for (let i = 23; i >= 0; i--) {
            const hour = new Date(now);
            hour.setHours(now.getHours() - i);
            const hourKey = `${hour.getFullYear()}-${hour.getMonth()+1}-${hour.getDate()}-${hour.getHours()}`;
            const hourStat = this.stats.hourlyStats.get(hourKey);
            
            history.push({
                period: 'hour',
                time: `${hour.getHours()}:00`,
                maxOnline: hourStat ? hourStat.maxOnline : 0,
                avgOnline: hourStat ? hourStat.avgOnline : 0,
                timestamp: hourStat ? hourStat.timestamp : hour.toISOString()
            });
        }
        
        // Última hora por minuto (detallado)
        const minuteHistory = [];
        for (let i = 59; i >= 0; i--) {
            const minute = new Date(now);
            minute.setMinutes(now.getMinutes() - i);
            const minuteKey = `${minute.getFullYear()}-${minute.getMonth()+1}-${minute.getDate()}-${minute.getHours()}-${minute.getMinutes()}`;
            const minuteStat = this.stats.onlineHistory.get(minuteKey);
            
            if (minuteStat || i < 5) { // Incluir últimos 5 minutos aunque no haya datos
                minuteHistory.push({
                    time: `${minute.getHours()}:${minute.getMinutes().toString().padStart(2, '0')}`,
                    online: minuteStat ? minuteStat.online : this.stats.online,
                    timestamp: minuteStat ? minuteStat.timestamp : now.toISOString()
                });
            }
        }
        
        return {
            currentOnline: this.stats.online,
            peakOnline: this.stats.peakOnline,
            history: history,
            recentMinutes: minuteHistory.slice(-30), // Últimos 30 minutos
            lastUpdate: now.toISOString()
        };
    }

    // NUEVA: Calcular tiempo activo de un jugador
    async getPlayerActiveTime(userId) {
        this.cleanupSessions();
        
        if (!userId) {
            const activePlayers = [];
            for (const [_, user] of this.stats.uniqueUsers) {
                const session = this.findUserSession(user.userId);
                const activeTime = this.calculatePlayerActiveTime(user, session);
                activePlayers.push({
                    userId: user.userId,
                    playerName: user.playerName,
                    totalActiveTime: user.totalActiveTime || 0,
                    currentSessionTime: activeTime.currentSessionTime,
                    lastSeen: user.lastSeen,
                    isOnline: !!session
                });
            }
            
            // Ordenar por tiempo activo (descendente)
            activePlayers.sort((a, b) => b.totalActiveTime - a.totalActiveTime);
            
            return {
                success: true,
                count: activePlayers.length,
                players: activePlayers.slice(0, 50) // Top 50
            };
        }
        
        const userKey = `user_${userId}`;
        const user = this.stats.uniqueUsers.get(userKey);
        
        if (!user) {
            return {
                success: false,
                error: 'Usuario no encontrado'
            };
        }
        
        const session = this.findUserSession(userId);
        const activeTime = this.calculatePlayerActiveTime(user, session);
        
        return {
            success: true,
            userId: user.userId,
            playerName: user.playerName,
            stats: {
                firstSeen: user.firstSeen,
                lastSeen: user.lastSeen,
                totalExecutions: user.totalExecutions,
                totalActiveTime: user.totalActiveTime || 0,
                totalActiveTimeFormatted: this.formatTime(user.totalActiveTime || 0),
                currentSessionTime: activeTime.currentSessionTime,
                currentSessionTimeFormatted: this.formatTime(activeTime.currentSessionTime),
                isOnline: activeTime.isOnline,
                sessionsCount: user.sessions ? user.sessions.length : 0
            }
        };
    }

    // NUEVA: Lista de jugadores activos con su tiempo
    async getActivePlayersWithTime() {
        this.cleanupSessions();
        
        const activePlayers = [];
        
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            const userKey = `user_${session.userId}`;
            const user = this.stats.uniqueUsers.get(userKey);
            
            if (user) {
                const sessionTime = Date.now() - (session.created || Date.now());
                
                activePlayers.push({
                    userId: session.userId,
                    playerName: session.playerName,
                    sessionId: sessionId,
                    activeTime: sessionTime,
                    activeTimeFormatted: this.formatTime(sessionTime),
                    lastHeartbeat: session.lastHeartbeat,
                    lastHeartbeatFormatted: new Date(session.lastHeartbeat).toISOString(),
                    gameId: session.gameId
                });
            }
        }
        
        // Ordenar por tiempo activo (más tiempo primero)
        activePlayers.sort((a, b) => b.activeTime - a.activeTime);
        
        return {
            success: true,
            online: this.stats.online,
            players: activePlayers,
            timestamp: new Date().toISOString()
        };
    }

    // NUEVO: Buscar sesión activa de un usuario
    findUserSession(userId) {
        for (const [_, session] of this.stats.sessions.entries()) {
            if (session.userId === userId) {
                return session;
            }
        }
        return null;
    }

    // NUEVO: Calcular tiempo activo de un jugador
    calculatePlayerActiveTime(user, session) {
        const now = Date.now();
        let currentSessionTime = 0;
        let isOnline = false;
        
        if (session) {
            isOnline = true;
            const sessionStart = session.created || now;
            currentSessionTime = now - sessionStart;
            
            // Actualizar tiempo total si hay sesión activa
            if (user) {
                user.totalActiveTime = (user.totalActiveTime || 0) + (now - (user.lastActiveUpdate || sessionStart));
                user.lastActiveUpdate = now;
            }
        } else if (user && user.currentSessionStart) {
            // Sesión terminada, calcular tiempo de la última sesión
            currentSessionTime = now - user.currentSessionStart;
            user.totalActiveTime = (user.totalActiveTime || 0) + currentSessionTime;
            user.currentSessionStart = null;
        }
        
        return {
            isOnline,
            currentSessionTime,
            totalActiveTime: user ? (user.totalActiveTime || 0) : 0
        };
    }

    // NUEVO: Formatear tiempo en formato legible
    formatTime(ms) {
        if (ms < 1000) return `${ms}ms`;
        
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    // NUEVO: Limpiar historial de online (mantener últimas 24 horas)
    cleanupOnlineHistory() {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        const keysToDelete = [];
        
        for (const [key, value] of this.stats.onlineHistory.entries()) {
            if (new Date(value.timestamp).getTime() < oneDayAgo) {
                keysToDelete.push(key);
            }
        }
        
        for (const key of keysToDelete) {
            this.stats.onlineHistory.delete(key);
        }
    }

    cleanupSessions() {
        const now = Date.now();
        const sessionsToDelete = [];
        
        for (const [sessionId, session] of this.stats.sessions.entries()) {
            // 10 minutos sin heartbeat = sesión muerta
            if (now - session.lastHeartbeat > 10 * 60 * 1000) {
                sessionsToDelete.push(sessionId);
                
                // Actualizar tiempo total del usuario
                const userKey = `user_${session.userId}`;
                const user = this.stats.uniqueUsers.get(userKey);
                if (user) {
                    const sessionTime = now - (session.created || now);
                    user.totalActiveTime = (user.totalActiveTime || 0) + sessionTime;
                    user.currentSessionStart = null;
                    user.lastActiveUpdate = null;
                }
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
        if (!sessionId || !userId) {
            return { success: false, online: this.stats.online };
        }
        
        this.cleanupSessions();
        
        const now = Date.now();
        
        if (this.stats.sessions.has(sessionId)) {
            const session = this.stats.sessions.get(sessionId);
            
            // Calcular tiempo desde último heartbeat y acumular
            const timeSinceLastHeartbeat = now - (session.lastHeartbeat || now);
            if (timeSinceLastHeartbeat > 0 && timeSinceLastHeartbeat < 60000) { // Menos de 1 minuto
                session.totalActiveTime = (session.totalActiveTime || 0) + timeSinceLastHeartbeat;
                
                // Actualizar tiempo total del usuario
                const userKey = `user_${userId}`;
                const user = this.stats.uniqueUsers.get(userKey);
                if (user) {
                    user.totalActiveTime = (user.totalActiveTime || 0) + timeSinceLastHeartbeat;
                    user.lastActiveUpdate = now;
                }
            }
            
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
                    lastActivity: now,
                    totalActiveTime: 0
                });
                
                // Actualizar inicio de sesión en usuario
                const userKey = `user_${userId}`;
                const user = this.stats.uniqueUsers.get(userKey);
                if (user) {
                    user.currentSessionStart = now;
                }
                
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
            const toSave = {
                ...this.stats,
                uniqueUsers: Object.fromEntries(this.stats.uniqueUsers),
                sessions: Object.fromEntries(this.stats.sessions),
                hourlyStats: Object.fromEntries(this.stats.hourlyStats),
                dailyStats: Object.fromEntries(this.stats.dailyStats.entries()),
                onlineHistory: Object.fromEntries(this.stats.onlineHistory.entries()) // NUEVO
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

        const id = env.CONTADOR_STATS.idFromName('main');
        const obj = env.CONTADOR_STATS.get(id);
        
        // APIs existentes
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
        
        // NUEVAS APIs
        if (path === '/api/online-history' || path === '/api/online-history.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/online-history';
            return obj.fetch(newUrl);
        }
        
        if (path === '/api/player-time' || path === '/api/player-time.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/player-time';
            return obj.fetch(newUrl);
        }
        
        if (path === '/api/active-players' || path === '/api/active-players.js') {
            const newUrl = new URL(url);
            newUrl.pathname = '/active-players';
            return obj.fetch(newUrl);
        }
        
        // Script para Roblox - ACTUALIZADO
        if (path === '/api/script' || path === '/api/script.js') {
            const baseUrl = `https://${url.hostname}`;
            
            const script = `-- 🏆 CONTADOR DORADO - CON TIEMPO DE JUEGO 🏆
-- Ahora con medición de tiempo activo
local HttpService = game:GetService("HttpService")
local player = game.Players.LocalPlayer

local API = "${baseUrl}/api"
local sessionId = "S_" .. player.UserId .. "_" .. math.random(1000,9999)
local startTime = os.clock()
local totalPlayTime = 0

print("🏆 CONTADOR DORADO - CON TIEMPO DE JUEGO")

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
        return nil
    end
end

-- Registro inicial
print("📤 Registrando ejecución...")
local response = sendRequest("count.js", {
    userId = player.UserId,
    playerName = player.Name,
    sessionId = sessionId,
    gameId = game.GameId
})

if response then
    local jsonSuccess, data = pcall(function()
        return HttpService:JSONDecode(response)
    end)
    
    if jsonSuccess and data.stats then
        print("✅ Registrado - Total: " .. data.stats.total .. " | Online: " .. data.stats.online)
    end
end

-- Heartbeat mejorado con tiempo de juego
print("💓 Heartbeat iniciado (cada 30 segundos)")
local heartbeatCount = 0

while true do
    task.wait(30)
    
    heartbeatCount = heartbeatCount + 1
    totalPlayTime = os.clock() - startTime
    
    local result = sendRequest("heartbeat.js", {
        sessionId = sessionId,
        userId = player.UserId
    })
    
    if result then
        local jsonSuccess, data = pcall(function()
            return HttpService:JSONDecode(result)
        end)
        
        if jsonSuccess and data.success then
            if heartbeatCount % 5 == 0 then
                print(string.format("💗 Heartbeat #%d - Online: %d - Tiempo: %.1f min", 
                    heartbeatCount, data.online, totalPlayTime / 60))
            end
        end
    end
    
    -- Verificar tiempo de juego cada 10 heartbeats
    if heartbeatCount % 10 == 0 then
        local timeData = sendRequest("player-time.js", {
            userId = player.UserId
        })
        
        if timeData then
            local jsonSuccess, data = pcall(function()
                return HttpService:JSONDecode(timeData)
            end)
            
            if jsonSuccess and data.success then
                print("⏱️ Tu tiempo total: " .. data.stats.totalActiveTimeFormatted)
                if data.stats.isOnline then
                    print("   Sesión actual: " .. data.stats.currentSessionTimeFormatted)
                end
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
        
        if (path === '/api/debug') {
            const id = env.CONTADOR_STATS.idFromName('main');
            const obj = env.CONTADOR_STATS.get(id);
            const newUrl = new URL(url);
            newUrl.pathname = '/debug';
            return obj.fetch(newUrl);
        }
        
        if (path === "/") {
            return new Response(JSON.stringify({
                message: "Contador Dorado API - Con tiempo de juego",
                endpoints: {
                    counter: "/api/counter.js",
                    stats: "/api/stats.js (ahora con online por hora)",
                    "online-history": "/api/online-history.js",
                    "player-time": "/api/player-time.js?userId=123",
                    "active-players": "/api/active-players.js",
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
                '/api/online-history.js',
                '/api/player-time.js',
                '/api/active-players.js',
                '/api/script.js',
                '/'
            ]
        }), {
            status: 404,
            headers: { ...headers, 'Content-Type': 'application/json' }
        });
    }
};

export { ContadorStats };
