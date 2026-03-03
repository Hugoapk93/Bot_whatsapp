    const API_BASE = '';
    let flow = {}, users = [];
    let pollingInterval = null, deferredPrompt;
    let apptToDelete = null;
    let allContactsCache = [];
    let currentRefDate = new Date();
    let currentChatPhone = null;
    let pendingJumpStep = null;
    let pendingCrmAction = null;
    let currentFilter = 'all';
    
    // --- VARIABLES DE SELECCIÓN NUEVAS ---
    let isSelectionMode = false;
    let selectedChats = []; 
    let longPressTimer;
    let ignoreClick = false;
    let currentSearchQuery = '';

    // --- SOCKET.IO ---
    const socket = io({ reconnection: true });
    socket.on('connect', () => { updateConnStatus(true); loadActivity(); });
    socket.on('disconnect', () => { updateConnStatus(false); });

    socket.on('message', (data) => {
        if (currentChatPhone) {
            // Limpiamos los IDs para evitar problemas de formato
            const currentKey = String(currentChatPhone).replace(/\D/g, ''); // Chat abierto
            const msgFromKey = String(data.from || '').replace(/\D/g, '');  // Quien envía
            const msgToKey   = String(data.to || '').replace(/\D/g, '');    // A quien va

            // A) INTENTO 1: Coincidencia Directa
            let isMatch = (currentKey === msgFromKey || currentKey === msgToKey);

            // B) INTENTO 2: Búsqueda Cruzada (Para LIDs)
            if (!isMatch && users.length > 0) {
                const senderUser = users.find(u => {
                    const uPhone = String(u.phone).replace(/\D/g, '');
                    const uDbPhone = u.realDbPhone ? String(u.realDbPhone).replace(/\D/g, '') : '';
                    return uPhone === msgFromKey || uDbPhone === msgFromKey;
                });

                if (senderUser) {
                    const senderKey = String(senderUser.phone).replace(/\D/g, '');
                    if (senderKey === currentKey) {
                        isMatch = true; 
                    }
                }
            }

            // C) SI ES EL CHAT CORRECTO -> PINTAMOS (Solo agregamos la burbuja)
            if (isMatch) {
                 let realText = data.text || data.body || data.caption || data.message || '';
                 
                 // Soporte extra
                 if(!realText && data.extendedTextMessage) realText = data.extendedTextMessage.text;
                 if(!realText && data.conversation) realText = data.conversation;
                 if(!realText && data.imageMessage) realText = data.imageMessage.caption || '📷 Foto';
                 if(!realText && data.videoMessage) realText = data.videoMessage.caption || '🎥 Video';
                 
                 if(realText) {
                     // Solo dibujamos, NO recargamos la base de datos
                     addBubble(realText, data.fromMe, null, new Date().toISOString());
                 }
            }
        }
    });

    socket.on('user_update', (data) => {
        // 1. Actualizar la lista en memoria
        const targetPhone = getCleanPhone(data.phone);
        const userIndex = users.findIndex(u => getCleanPhone(u.phone) === targetPhone);

        if (userIndex !== -1) {
            // Actualizamos los datos locales
            users[userIndex] = { ...users[userIndex], ...data };
            
            // Si el backend mandó un nombre nuevo, actualizamos el nombre visual
            if (data.name) {
                users[userIndex].savedName = data.name;
                if (!users[userIndex].history) users[userIndex].history = {};
                users[userIndex].history.nombre = data.name;
            }
        }

        // 2. Refrescar la lista izquierda
        renderChatList(users);

        // 3. Si tenemos este chat abierto, actualizamos el encabezado al instante
        if (currentChatPhone && getCleanPhone(currentChatPhone) === targetPhone) {
            if (data.name) {
                document.getElementById('waHeaderName').innerText = data.name;
                document.getElementById('waHeaderAvatar').innerText = data.name[0].toUpperCase();
            }
            if (data.bot_enabled !== undefined) {
                const sw = document.getElementById('waBotSwitch');
                if (sw) sw.checked = data.bot_enabled;
            }
        }
    });

    socket.on('new_user', (newUser) => {
        const exists = users.find(u => getCleanPhone(u.phone) === getCleanPhone(newUser.phone));
        if (!exists) {
            newUser.savedName = newUser.name || newUser.phone;
            users.unshift(newUser); // Agregamos al principio
            renderChatList(users);
            showInAppNotify(`Nuevo cliente: ${newUser.savedName}`);
        }
    });

    function showInAppNotify(text) {
        const el = document.getElementById('inAppNotify');
        if(!el) return;
        const txtEl = document.getElementById('notifyText');
        if(txtEl) txtEl.innerText = text.substring(0, 30) + (text.length>30?'...':'');
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 4000);
    }

    function updateConnStatus(online) {
       console.log('Socket status:', online ? 'Connected' : 'Disconnected');
    }

    // --- ONLOAD E INICIALIZACIÓN ---
    window.onload = () => {
        if (localStorage.getItem('theme') === 'dark') {
            document.body.classList.add('dark-mode');
            // Encendemos el switch visualmente si el tema oscuro está activo
            const dmSwitch = document.getElementById('darkModeSwitch');
            if (dmSwitch) dmSwitch.checked = true;
            const dmText = document.getElementById('darkModeStatusText');
            if (dmText) dmText.innerText = 'Activado';
        }

        const wizard = document.getElementById('setupWizard');
        if(wizard) wizard.classList.remove('step-hidden');

        const checkStatus = async () => {
            try {
                const res = await (await fetch(`${API_BASE}/api/status`)).json();
                if(res.status === 'connected') {
                    if(wizard) wizard.classList.add('step-hidden');
                    document.getElementById('mainApp').classList.add('visible');

                    loadAll();
                    await loadActivity();

                    if (window.location.hash === '#agenda') {
                        nav('agenda'); 
                        history.replaceState(null, null, ' ');
                    }
                    // --- ACTIVITY (MODIFICADO PARA ABRIR CHAT) ---
                    else if (window.location.hash.startsWith('#activity')) {
                        const hash = window.location.hash;
                        nav('activity');
                        
                        // Si la URL trae "?chat=521...", abrimos ese chat específico
                        if (hash.includes('chat=')) {
                            const phone = hash.split('chat=')[1];
                            setTimeout(() => openWaChat(phone), 200);
                        }

                        history.replaceState(null, null, ' ');
                    }

                } else if(res.qr) {
                    const loading = document.getElementById('stepLoading');
                    const qrStep = document.getElementById('stepQR');
                    if(loading) loading.classList.add('step-hidden');
                    if(qrStep) qrStep.classList.remove('step-hidden');
                    new QRious({element: document.getElementById('qrCanvas'), value: res.qr, size:200});
                }
            } catch(e){}
            
            if(wizard && !wizard.classList.contains('step-hidden')) {
                setTimeout(checkStatus, 3000);
            }
        };
        checkStatus();

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW Fail', err));
        }
    };

    document.body.addEventListener('click', function() {
        if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
            Notification.requestPermission();
        }
    }, { once: true });

    async function loadAll() {
        try { flow = await (await fetch(`${API_BASE}/api/flow`)).json(); renderFlowList(); } catch(e){}

        try { 
            const s = await (await fetch(`${API_BASE}/api/settings`)).json(); 
            if(s.schedule) { 
                const act = document.getElementById('schedActive'); if(act) act.checked = s.schedule.active;
                const start = document.getElementById('schedStart'); if(start) start.value = s.schedule.start;
                const end = document.getElementById('schedEnd'); if(end) end.value = s.schedule.end;
                const msg = document.getElementById('schedMsg'); if(msg) msg.value = s.schedule.offline_message; 

                if(typeof toggleSettingsUI === 'function') toggleSettingsUI();
            } 
        } catch(e){}
    }

    const getCleanPhone = (ph) => {
        if (!ph) return '';
        const str = String(ph).replace(/\D/g, '');
        if (str.length > 14) return str;
        if (str.length >= 10) return str.slice(-10);
        return str;
    };

    async function loadActivity() {
        try {
            const [usersData, contactsData] = await Promise.all([
                (await fetch(`${API_BASE}/api/users`)).json(),
                (await fetch(`${API_BASE}/api/contacts`)).json()
            ]);

            allContactsCache = contactsData;

            users = usersData.map(u => {
                const uChatKey = getCleanPhone(u.phone);
                // Buscamos coincidencia en contactos guardados
                let contactInfo = contactsData.find(c => getCleanPhone(c.phone) === uChatKey);
                
                let finalState = true;
                let savedName = u.history?.nombre || u.history?.cliente || u.history?.usuario || u.history?.name || u.phone;

                if (contactInfo) {
                    finalState = contactInfo.bot_enabled;
                    if(contactInfo.name && contactInfo.name !== 'Usuario Chat' && contactInfo.name !== u.phone) {
                        savedName = contactInfo.name;
                    }
                } else if (u.bot_enabled !== undefined) {
                    finalState = u.bot_enabled;
                }

                if (savedName === u.phone && u.pushName) {
                    savedName = u.pushName; 
                }

                return {
                    ...u,
                    bot_enabled: finalState,
                    savedName: savedName,
                    realDbPhone: contactInfo ? contactInfo.phone : u.phone
                };
            });

            renderChatList(users);

            // Si hay un chat abierto, actualizamos su estado (switch del bot)
            if (currentChatPhone) {
                const updatedUser = users.find(u => getCleanPhone(u.phone) === getCleanPhone(currentChatPhone));
                if(updatedUser) {
                    const switchEl = document.getElementById('waBotSwitch');
                    if(switchEl) switchEl.checked = updatedUser.bot_enabled;
                    
                    // Actualizar también el nombre en el encabezado si cambió
                    document.getElementById('waHeaderName').innerText = updatedUser.savedName;
                }
            }

        } catch(e){ console.error("Error cargando actividad:", e); }
    }

    function renderChatList(list) {
        const c = document.getElementById('waChatList');
        if(!c) return; 
        c.innerHTML = '';
        
        list.sort((a,b) => new Date(b.last_active) - new Date(a.last_active));

        list.forEach(u => {
            if(u.phone === 'TEST_SIMULADOR') return;
            
            // 1. Datos
            const name = u.savedName || u.history?.nombre || u.history?.cliente || u.history?.usuario || u.phone;

            const timeDisplay = formatSmartDate(u.last_active);
            
            // 2. Estados y Clases
            const isSelected = selectedChats.includes(u.phone);
            const activeClass = (currentChatPhone === u.phone) ? 'active' : '';
            const selectedClass = isSelected ? 'selected' : '';
            
            const checkIcon = isSelected 
                ? '<div style="position:absolute; bottom:0; right:0; background:#00a884; width:18px; height:18px; border-radius:50%; border:2px solid #202c33; display:flex; align-items:center; justify-content:center; color:white; font-size:9px; z-index:10;"><i class="fas fa-check"></i></div>' 
                : '';
            
            const statusIcon = u.bot_enabled ? '<i class="fas fa-robot" style="color:var(--success)"></i>' : '<i class="fas fa-ban" style="color:var(--danger)"></i>';
            const rawMsg = u.last_message || '...';
            const lastMsg = escapeHTML(rawMsg); 

            const div = document.createElement('div');
            div.className = `wa-chat-item ${activeClass} ${selectedClass}`;
            div.oncontextmenu = function(e) { e.preventDefault(); return false; }; 
            
            // 🔥 CAMBIO: Nueva estructura HTML para separar nombre y hora
            div.innerHTML = `
                <div class="wa-avatar" style="position:relative; overflow:visible;">
                    ${name[0].toUpperCase()} 
                    ${checkIcon}
                </div>
                
                <div class="wa-chat-info">
                    <div class="wa-row-top">
                        <span class="wa-name" title="${name}">${name}</span>
                        <span class="wa-time-meta">${timeDisplay}</span>
                    </div>
                    
                    <div class="wa-msg-preview">
                        ${statusIcon} 
                        <span style="color:var(--primary); font-size:0.75rem; margin:0 5px;">[${u.current_step}]</span> 
                        <span style="overflow:hidden; text-overflow:ellipsis;">${lastMsg}</span>
                    </div>
                </div>
            `;

            // --- Lógica de Eventos (INTACTA) ---
            const startPress = (e) => {
                if (e.type === 'mousedown' && e.button !== 0) return;
                ignoreClick = false;
                longPressTimer = setTimeout(() => {
                    ignoreClick = true;
                    toggleSelection(u.phone);
                    if (navigator.vibrate) navigator.vibrate(50);
                }, 600);
            };

            const cancelPress = () => clearTimeout(longPressTimer);

            const handleClick = (e) => {
                if (ignoreClick) {
                    ignoreClick = false;
                    return;
                }
                if (isSelectionMode) {
                    toggleSelection(u.phone);
                } else {
                    openWaChat(u.phone);
                }
            };

            div.addEventListener('mousedown', startPress);
            div.addEventListener('touchstart', startPress, {passive: true});
            div.addEventListener('mouseup', cancelPress);
            div.addEventListener('mouseleave', cancelPress);
            div.addEventListener('touchend', cancelPress);
            div.addEventListener('touchmove', cancelPress);
            div.addEventListener('click', handleClick);

            c.appendChild(div);
        });
    }

    function toggleSelection(phone) {
        if (!isSelectionMode) {
            isSelectionMode = true;
            document.getElementById('waHeaderSearch').style.display = 'none';
            document.getElementById('waHeaderSelection').style.display = 'flex';
        }

        if (selectedChats.includes(phone)) {
            selectedChats = selectedChats.filter(p => p !== phone);
        } else {
            selectedChats.push(phone);
        }

        document.getElementById('waSelectionCount').innerText = selectedChats.length;

        if (selectedChats.length === 0) {
            exitSelectionMode();
        } else {
            // 🔥 CORRECCIÓN: Usamos filterChats en vez de renderChatList(users)
            // Esto obliga a la lista a respetar lo que escribiste en el buscador
            filterChats(currentSearchQuery); 
        }
    }

    function exitSelectionMode() {
        isSelectionMode = false;
        selectedChats = [];
        document.getElementById('waHeaderSearch').style.display = 'block';
        document.getElementById('waHeaderSelection').style.display = 'none';
        
        // 🔥 CORRECCIÓN: Al salir, volvemos a mostrar la lista filtrada (o completa si estaba vacía)
        filterChats(currentSearchQuery);
    }

    async function deleteSelectedChats() {
        if(selectedChats.length === 0) return;
        if(!confirm(`¿Eliminar ${selectedChats.length} chats?`)) return;

        try {
            for (const phone of selectedChats) {
                 await fetch(`${API_BASE}/api/contacts/delete`, {
                    method:'POST',
                    headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({phone: phone})
                });
            }

            users = users.filter(u => !selectedChats.includes(u.phone));
            if(allContactsCache) allContactsCache = allContactsCache.filter(u => !selectedChats.includes(u.phone));

            if (selectedChats.includes(currentChatPhone)) closeWaChat();

            showToast(`${selectedChats.length} chats eliminados`);
            exitSelectionMode();
        } catch (e) {
            console.error(e);
            showToast("Error al eliminar");
            exitSelectionMode();
        }
    }

    // --- CHAT Y MENSAJES ---
    async function toggleCurrentBot(val) {
        const switchEl = document.getElementById('waBotSwitch');
        if (!currentChatPhone) return;

        const targetKey = getCleanPhone(currentChatPhone);
        const u = users.find(x => getCleanPhone(x.phone) === targetKey);
        if (!u) {
            if (switchEl) switchEl.checked = !val;
            return;
        }
        const phoneToSend = u.realDbPhone || u.phone || currentChatPhone;

        try {
            const response = await fetch(`${API_BASE}/api/contacts/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phoneToSend, enable: val })
            });
            const data = await response.json();

            if (data.success) {
                showToast(val ? 'Bot Activado' : 'Bot Pausado');
                u.bot_enabled = val;
                const cachedContact = allContactsCache.find(c => getCleanPhone(c.phone) === targetKey);
                if (cachedContact) cachedContact.bot_enabled = val;
                renderChatList(users);
            } else { throw new Error("Error server"); }
        } catch (e) {
            showToast("Error actualizando bot");
            if (switchEl) switchEl.checked = !val;
            u.bot_enabled = !val;
        }
    }

    function openWaChat(phone, isRefresh = false) {
        currentChatPhone = phone;

        const targetKey = getCleanPhone(phone);
        const u = users.find(x => getCleanPhone(x.phone) === targetKey);
        if(!u) return;

        // Header
        const displayName = u.savedName || u.history?.cliente || u.history?.usuario || u.phone;
        document.getElementById('waHeaderName').innerText = displayName;
        document.getElementById('waHeaderPhone').innerText = u.phone; 
        document.getElementById('waHeaderAvatar').innerText = displayName[0].toUpperCase();

        const switchEl = document.getElementById('waBotSwitch');
        if(switchEl) switchEl.checked = u.bot_enabled; 

        // Mensajes
        const box = document.getElementById('waMsgContainer');
        const msgs = u.messages || [];

        if (!isRefresh) {
            box.innerHTML = '';
            document.getElementById('waInputArea').style.display = 'flex';
            if(msgs.length === 0) {
                box.innerHTML = `<div style="text-align:center; padding:40px; color:rgba(255,255,255,0.4);">
                    <i class="fas fa-comment-slash" style="font-size:2rem; margin-bottom:10px;"></i><br>
                    Sin historial reciente.
                </div>`;
            } else {
                msgs.forEach(m => addBubble(m.text, m.fromMe, m.stepId, m.timestamp));
                setTimeout(() => box.scrollTop = box.scrollHeight, 50);
            }
            if(window.innerWidth <= 768) {
                const mainChat = document.getElementById('waMainChat');
                if(mainChat) mainChat.classList.add('mobile-open');
            }
        } else {
            const domCount = box.querySelectorAll('.wa-bubble').length;
            const dbCount = msgs.length;
            if (dbCount > domCount) {
                const newMsgs = msgs.slice(domCount);
                newMsgs.forEach(m => addBubble(m.text, m.fromMe, m.stepId, m.timestamp));
                if(box.scrollTop + box.clientHeight >= box.scrollHeight - 100) {
                    box.scrollTop = box.scrollHeight;
                }
            }
        }

        // Quick Replies
        const qrContainer = document.getElementById('waQuickReplies');
        qrContainer.innerHTML = ''; 
        qrContainer.style.display = 'none';

        const currentStepId = u.current_step;
        if (currentStepId && flow[currentStepId]) {
            const stepData = flow[currentStepId];
            if (stepData.type === 'filtro' && stepData.options && stepData.options.length > 0) {
                qrContainer.style.display = 'flex'; 
                stepData.options.forEach(opt => {
                    const btn = document.createElement('button');
                    btn.className = 'quick-btn';
                    btn.innerText = opt.label; 
                    btn.onclick = () => {
                        const clientName = document.getElementById('waHeaderName').innerText;
                        askCrmAction(currentChatPhone, opt.next_step, opt.label, clientName);
                    };
                    qrContainer.appendChild(btn);
                });
            }
        }
        renderChatList(users);
    }

    function addBubble(text, isMe, stepId, timestamp) {
        const box = document.getElementById('waMsgContainer');
        const canClick = (isMe && stepId);

        let timeStr = '';
        if (timestamp) {
            const dateObj = new Date(timestamp);
            timeStr = dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', hour12: false});
        }

        const safeText = text
            ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
            : '';

        const safeStepId = stepId ? String(stepId).replace(/'/g, "\\'") : '';

        const html = `<div class="wa-bubble ${isMe ? 'out' : 'in'} ${canClick ? 'clickable' : ''}" ${canClick ? `onclick="askJump('${safeStepId}')"` : ''} title="${canClick ? 'Click para restaurar' : ''}">${safeText}<span class="wa-time">${timeStr}</span></div>`;

        // --- LÓGICA DE AUTO-SCROLL INTELIGENTE ---
        const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;

        // 2. Inyectamos el nuevo mensaje
        box.insertAdjacentHTML('beforeend', html);

        if (isNearBottom || isMe) {
            box.scrollTop = box.scrollHeight;
        }
    }

    function closeWaChat() {
        const mainChat = document.getElementById('waMainChat');
        if(mainChat) mainChat.classList.remove('mobile-open');
        currentChatPhone = null;
        renderChatList(users);
    }

    async function sendWaMsg() {
        const inp = document.getElementById('waInput');
        const txt = inp.value.trim();
        if(!txt || !currentChatPhone) return;

        // Limpiamos input y reseteamos iconos
        inp.value = '';
        handleInputTyping();
        document.getElementById('waFlowDrawer').classList.remove('open'); 

        // 🔥 COMANDOS (>> PASO)
        if (txt.startsWith('>> ')) {
            const targetStep = txt.replace('>> ', '').trim();
            
            // Aquí SÍ usamos addBubble porque es un mensaje interno del sistema (no de WhatsApp)
            addBubble(`🔄 <i>Forzando paso: ${targetStep}</i>`, true);

            try {
                await fetch(`${API_BASE}/api/crm/execute`, {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ phone: currentChatPhone, stepId: targetStep })
                });
                setTimeout(loadActivity, 500);
            } catch (e) {
                showToast("❌ Error al cambiar paso");
            }
            return; 
        }

        try {
            await fetch(`${API_BASE}/api/send-message`, {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ phone: currentChatPhone, text: txt })
            });
        } catch (e) {
            console.error(e);
            showToast("❌ Error enviando mensaje");
        }
    }

    function filterChats(q) {
        currentSearchQuery = q; // 1. Guardamos el texto para no olvidarlo
        
        if(!q) {
            renderChatList(users);
        } else {
            const term = q.toLowerCase();
            const f = users.filter(u => {
                // Buscamos en todo el objeto o específicamente en el nombre/teléfono
                const str = JSON.stringify(u).toLowerCase(); 
                const savedName = (u.savedName || '').toLowerCase();
                return str.includes(term) || savedName.includes(term);
            });
            renderChatList(f);
        }
    }

    // --- ACCIONES Y MODALES ---
    function askJump(step) {
        if(!currentChatPhone) return;
        pendingJumpStep = step;
        document.getElementById('jumpTargetStep').innerText = step;
        document.getElementById('jumpModal').classList.add('active');
    }

    async function executeJump() {
        if(!pendingJumpStep || !currentChatPhone) return;

        // 1. 🔥 ¡CERRAR AL INSTANTE! 🔥
        document.getElementById('jumpModal').classList.remove('active');
        
        // Opcional: Mostrar un toast para que sepa que sí pasó algo
        showToast("🔄 Procesando...");

        try {
            // 2. La petición se hace mientras la ventana ya está cerrada
            await fetch(`${API_BASE}/api/crm/execute`, {
                method:'POST', 
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ phone: currentChatPhone, stepId: pendingJumpStep })
            });

            // 3. Cuando el servidor termine, actualizamos el chat
            addBubble(`🔄 Sistema: Usuario movido a ${pendingJumpStep}`, true);
            loadActivity();
        } catch (e) {
            console.error(e);
            alert("❌ Error de conexión: No se pudo mover al usuario.");
        }
    }

    function askCrmAction(phone, step, label, clientName) {
        pendingCrmAction = { phone, step };
        document.getElementById('actLabel').innerText = label;
        document.getElementById('actClient').innerText = clientName;
        document.getElementById('actionConfirmModal').classList.add('active');
    }

    async function executeCrmAction() {
        if(!pendingCrmAction) return;

        document.getElementById('actionConfirmModal').classList.remove('active');

        showToast("🔄 Procesando acción...");

        try {
            await fetch(`${API_BASE}/api/crm/execute`, {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({
                    phone: pendingCrmAction.phone,
                    stepId: pendingCrmAction.step
                })
            });

            pendingCrmAction = null;

            setTimeout(loadActivity, 500);

        } catch (e) {
            console.error(e);
            showToast("❌ Error al ejecutar acción");
        }
    }

    // --- FLUJO Y EDITOR ---
    let flowPath = [];

    function renderFlowList() {
        const c = document.getElementById('flowListContainer');
        if(!c) return;

        // 🚀 EL LIENZO INVISIBLE (BUFFER)
        let htmlBuffer = '';

        // --- NAVEGACIÓN (BREADCRUMBS) ---
        // Esto crea la barra superior: Inicio > BIENVENIDA > EFECTIVO...
        if (flowPath.length > 0) {
            let navHtml = `<div class="flow-nav" id="breadcrumbNav">`;
            // Botón atrás circular
            navHtml += `<button onclick="jumpToStep(${flowPath.length - 2})" class="admin-btn" style="border-radius:50%; width:30px; height:30px; display:flex; align-items:center; justify-content:center; padding:0; flex-shrink:0;"><i class="fas fa-arrow-left"></i></button>`;
            
            navHtml += `<span onclick="resetFlowNav()">Inicio</span>`;
            flowPath.forEach((step, index) => {
                const isLast = index === flowPath.length - 1;
                // Si es el último, lo ponemos en negrita, si no, es un link
                navHtml += ` <i class="fas fa-chevron-right" style="font-size:0.7rem; opacity:0.5;"></i> 
                             <span onclick="${isLast ? '' : `jumpToStep(${index})`}" style="${isLast ? 'font-weight:bold; color:var(--text-main)' : ''}">${step}</span>`;
            });
            navHtml += `</div>`;
            
            // Lo guardamos en el buffer en vez de imprimirlo
            htmlBuffer += navHtml; 
        }

        // --- LÓGICA CORREGIDA: QUÉ TARJETAS MOSTRAR ---
        let stepsToShow = [];
        
        if (flowPath.length === 0) {
            // Si no he navegado a nada, muestra las raíces (ej. BIENVENIDA)
            stepsToShow = findFlowRoots(); 
            // Fallback por si no encuentra raíces
            if(stepsToShow.length === 0 && Object.keys(flow).length > 0) {
                stepsToShow = [Object.keys(flow).sort()[0]];
            }
        } else {
            // 🔥 LA CORRECCIÓN CLAVE:
            // Antes mostrábamos los hijos (getChildrenSteps).
            // Ahora mostramos EL PASO ACTUAL en el que estamos parados.
            const currentStep = flowPath[flowPath.length - 1];
            stepsToShow = [currentStep];
        }

        // --- RENDERIZADO DE TARJETAS ---
        stepsToShow.forEach(k => {
            const step = flow[k];
            if(!step) return;

            let typeClass = 'type-message';
            let icon = '<i class="fas fa-comment-alt"></i>';
            if(step.type === 'menu') { typeClass = 'type-menu'; icon = '<i class="fas fa-list-ul"></i>'; }
            else if(step.type === 'input') { typeClass = 'type-input'; icon = '<i class="fas fa-pen-alt"></i>'; }
            else if(step.type === 'filtro') { typeClass = 'type-filtro'; icon = '<i class="fas fa-user-shield"></i>'; }
            else if(step.type === 'cita') { typeClass = 'type-cita'; icon = '<i class="far fa-calendar-check"></i>'; }
            else if(step.type === 'fin_bot') { typeClass = 'type-fin'; icon = '<i class="fas fa-flag-checkered"></i>'; }

            const userCount = users.filter(u => u.current_step === k).length;
            const badgeHtml = userCount > 0 ? `<div class="user-badge"><i class="fas fa-user"></i> ${userCount}</div>` : '';

            // BOTONES DE NAVEGACIÓN (CHIPS)
            // Estos son los botones que aparecen AL FINAL de la tarjeta para avanzar
            let chipsHtml = '';
            
            if(step.options && step.options.length > 0) {
                // Si es un menú con varias opciones
                step.options.forEach(opt => {
                    chipsHtml += `<div class="flow-chip" onclick="event.stopPropagation(); enterStep('${opt.next_step}')">
                        <span>${opt.label}</span> <i class="fas fa-arrow-right"></i>
                    </div>`;
                });
            }
            else if (step.next_step) {
                // Si es un paso lineal (ej. input o mensaje simple)
                chipsHtml = `<div class="flow-chip" onclick="event.stopPropagation(); enterStep('${step.next_step}')">
                    <span>Ir a: ${step.next_step}</span> <i class="fas fa-arrow-right"></i>
                </div>`;
            } else {
                 // Si no tiene salida (Fin del flujo)
                 chipsHtml = `<div style="text-align:center; padding:10px; opacity:0.5; font-size:0.8rem;">🏁 Fin del flujo</div>`;
            }

            // LIMPIEZA DE TEXTO (Para que no se vea desalineado)
            // Usamos .trim() y nos aseguramos de no dejar espacios en el template literal
            const cleanText = (step.message || '').trim() || '<span style="font-style:italic; opacity:0.5">(Sin texto)</span>';

            // HTML ESTRUCTURADO AL BUFFER
            htmlBuffer += `
            <div class="flow-step-card ${typeClass}">
                
                <div class="card-header" onclick="edit('${k}')">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:1.1rem; opacity:0.7;">${icon}</span>
                        <strong style="font-size:1rem;">${k}</strong>
                        ${badgeHtml}
                    </div>
                    <i class="fas fa-pen" style="font-size:0.8rem; opacity:0.5;"></i>
                </div>

                <div class="card-body" onclick="edit('${k}')">${cleanText}${step.media && step.media.length > 0 ? `<div class="thumb-row">${step.media.map(u=>`<div style="background-image:url('${u}');" class="thumb-img"></div>`).join('')}</div>` : ''}</div>

                <div class="card-footer">
                    ${chipsHtml}
                </div>

            </div>`;
        });

        // 🚀 PINTAMOS TODO DE UN SOLO GOLPE EN LA INTERFAZ
        c.innerHTML = htmlBuffer;
    }

    function enterStep(stepId) { flowPath.push(stepId); renderFlowList(); }
    function resetFlowNav() { flowPath = []; renderFlowList(); }
    function jumpToStep(index) { flowPath = flowPath.slice(0, index + 1); renderFlowList(); }

    function getChildrenSteps(parentId) {
        const parent = flow[parentId];
        if (!parent) return [];
        let kids = [];
        if (parent.next_step && flow[parent.next_step]) kids.push(parent.next_step);
        if (parent.options && Array.isArray(parent.options)) {
            parent.options.forEach(opt => {
                if (opt.next_step && flow[opt.next_step] && !kids.includes(opt.next_step)) {
                    kids.push(opt.next_step);
                }
            });
        }
        return kids;
    }

    function findFlowRoots() {
        const allSteps = Object.keys(flow);
        if(allSteps.length === 0) return [];
        const targetedSteps = new Set();
        allSteps.forEach(k => {
            const s = flow[k];
            if (s.next_step) targetedSteps.add(s.next_step);
            if (s.options) s.options.forEach(o => { if(o.next_step) targetedSteps.add(o.next_step); });
        });
        return allSteps.filter(s => !targetedSteps.has(s));
    }

    // --- LÓGICA DE FLUJO VERTICAL ---
    function getLinearFlowSequence() {
        const steps = Object.keys(flow);
        if(steps.length === 0) return [];
        
        let seq = [];
        // Intentamos seguir el hilo lógico comenzando por BIENVENIDA o el primero que hallemos
        let curr = 'BIENVENIDA'; 
        if(!flow[curr]) curr = steps[0]; // Fallback

        let safety = 0;
        
        // Rastreamos hacia adelante
        while(curr && flow[curr] && safety < 100) {
            if(!seq.includes(curr)) seq.push(curr);
            
            // Lógica para adivinar el siguiente paso "natural"
            let next = flow[curr].next_step;
            
            // Si no tiene next_step directo, miramos sus opciones (botones)
            if(!next && flow[curr].options && flow[curr].options.length > 0) {
                // Tomamos la primera opción como el camino "principal"
                next = flow[curr].options[0].next_step;
            }
            
            // Evitar bucles infinitos
            if(seq.includes(next)) break; 
            
            curr = next;
            safety++;
        }

        // Agregamos pasos huérfanos que no se alcanzaron (para que aparezcan al final)
        steps.forEach(s => {
            if(!seq.includes(s)) seq.push(s);
        });

        return seq;
    }

    // 2. Renderizador del Cajón
    function toggleFlowDrawer() {
        const drawer = document.getElementById('waFlowDrawer');
        if(drawer.classList.contains('open')) {
            drawer.classList.remove('open');
        } else {
            renderFlowDrawerContent();
            drawer.classList.add('open');
        }
    }

    function renderFlowDrawerContent() {
        if(!currentChatPhone) return;
        const user = users.find(u => getCleanPhone(u.phone) === getCleanPhone(currentChatPhone));
        const currentStep = user ? user.current_step : '';
        const sequence = getLinearFlowSequence();
        const drawer = document.getElementById('waFlowDrawer');
        
        drawer.innerHTML = '';
        
        let currentIndex = sequence.indexOf(currentStep);
        if(currentIndex === -1) currentIndex = -1; // No encontrado

        sequence.forEach((stepId, index) => {
            let statusClass = 'future';
            let icon = '<i class="far fa-circle"></i>';

            if (stepId === currentStep) {
                statusClass = 'current';
                icon = '<i class="fas fa-dot-circle"></i>';
            } else if (index < currentIndex && currentIndex !== -1) {
                statusClass = 'past';
                icon = '<i class="fas fa-check-circle"></i>';
            }

            const div = document.createElement('div');
            div.className = `flow-item-row ${statusClass}`;
            div.onclick = () => injectStepCommand(stepId);
            div.innerHTML = `
                <span>${icon} ${stepId}</span>
                <i class="fas fa-reply" style="opacity:0.5; font-size:0.8rem;"></i>
            `;
            drawer.appendChild(div);
        });

        // Auto-scroll para centrar el paso actual
        setTimeout(() => {
            const currentEl = drawer.querySelector('.current');
            if(currentEl) {
                currentEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }, 100);
    }

    // 3. Inyectar Comando en el Input
    function injectStepCommand(stepId) {
        const inp = document.getElementById('waInput');
        
        // 1. Escribimos el comando
        inp.value = `>> ${stepId}`; 
        
        // 2. 🔥 ESTO FALTABA: Avisar que hubo un cambio para activar la animación
        handleInputTyping(); 

        // 3. Poner el foco en el input
        inp.focus();
        
        // Opcional: Cerrar el menú automáticamente al elegir
        toggleFlowDrawer(); 
    }

    // --- EDITOR DE PASOS ---
    let currentMediaList = [];
    function edit(id) {
        const d = flow[id]; 
        document.getElementById('stId').value = id; 
        document.getElementById('stType').value = d.type;
        document.getElementById('stMsg').value = d.message || '';
        currentMediaList = d.media || [];
        renderGallery(); 
        renderFields(); 
        document.getElementById('editorModal').classList.add('active');
    }
    
    function renderGallery() {
        const c = document.getElementById('galleryContainer'); c.innerHTML='';
        currentMediaList.forEach((u,i) => c.innerHTML += `<div style="min-width:60px; height:60px; background:url(${u}) center/cover; border-radius:5px; position:relative;"><button onclick="currentMediaList.splice(${i},1); renderGallery()" style="position:absolute; top:-5px; right:-5px; background:red; border-radius:50%; width:18px; height:18px; border:none; color:white; font-size:10px;">x</button></div>`);
    }

    // Helper para Datalist (Autocompletado)
    const getDatalistOptions = () => {
        let opts = '';
        Object.keys(flow).sort().forEach(k => {
            opts += `<option value="${k}">`;
        });
        return opts;
    };

    function renderFields() {
        const type = document.getElementById('stType').value;
        const id = document.getElementById('stId').value;
        const d = flow[id] || {};
        const c = document.getElementById('dynFields');
        const wrapMsg = document.getElementById('wrapper-msg'), wrapMedia = document.getElementById('wrapper-media');
        
        // Ocultamos el mensaje por defecto y la galería si es una Cita
        wrapMsg.style.display = type === 'cita' ? 'none' : 'block'; 
        wrapMedia.style.display = type === 'cita' ? 'none' : 'block';

        // Generamos la lista de pasos existentes para sugerencias
        const dataListHtml = `<datalist id="stepsList">${getDatalistOptions()}</datalist>`;
        let html = dataListHtml; 

        if(type === 'menu' || type === 'filtro') {
            html += `<label>Opciones (Botones)</label><div id="optsList">`;
            (d.options||[]).forEach(o => {
                html += `<div style="display:flex; gap:5px; margin-bottom:5px;">
                    <input class="o-lbl" value="${o.label}" placeholder="Texto Botón">
                    <input class="o-nxt" list="stepsList" value="${o.next_step||''}" placeholder="Destino (Escribe para crear)" style="font-weight:bold; color:var(--primary);">
                    <button onclick="this.parentElement.remove()" style="color:var(--danger); background:none; border:none;">✕</button>
                </div>`;
            });
            html += `</div><button class="admin-btn" onclick="addOptRow()">+ Opción</button>`;
            if(type==='menu') html += `<label style="margin-top:10px">Keywords</label><input id="stKw" value="${(d.keywords||[]).join(', ')}">`;
            if(type==='filtro') html += `<label style="margin-top:10px">Admin Tel</label><input id="stAdm" value="${d.admin_number||''}">`;

        } else if (type === 'input') {
            html += `<label>Variable a Guardar</label><input id="stVar" value="${d.save_var||''}">`;
            html += `<label>Siguiente Paso Automático</label><input id="stNext" list="stepsList" value="${d.next_step||''}" placeholder="Escribe para crear nuevo...">`;

        } else if (type === 'cita') {
            html += `
            <div style="background:var(--bg-input); padding:15px; border-radius:8px; border:1px solid var(--border); margin-bottom:15px;">
                <h4 style="margin-top:0; margin-bottom:15px; color:var(--text-main);"><i class="far fa-calendar-alt" style="color:var(--primary);"></i> Configuración del Agendador</h4>
                
                <label>Pregunta para el Día</label>
                <input type="text" id="stCitaDate" value="${d.msg_date || '¿Qué día te gustaría agendar?'}" placeholder="Ej: ¿Qué día te esperamos?">
                
                <label>Pregunta para la Hora</label>
                <input type="text" id="stCitaTime" value="${d.msg_time || '¿A qué hora te queda mejor?'}" placeholder="Ej: Perfecto, ¿a qué hora te agendo?">
                
                <label>Duración de cada turno</label>
                <select id="stCitaInterval" style="margin-bottom:0;">
                    <option value="15" ${d.interval == '15' ? 'selected' : ''}>Cada 15 minutos</option>
                    <option value="30" ${d.interval == '30' || !d.interval ? 'selected' : ''}>Cada 30 minutos</option>
                    <option value="60" ${d.interval == '60' ? 'selected' : ''}>Cada 1 hora</option>
                    <option value="1440" ${d.interval == '1440' ? 'selected' : ''}>1 Cita por Día (Todo el día)</option>
                </select>
            </div>
            <label>Siguiente Paso (Al terminar de agendar)</label>
            <input id="stNext" list="stepsList" value="${d.next_step||''}" placeholder="Ej: DESPEDIDA">`;

        } else {
            html += `<label>Siguiente Paso Automático</label><input id="stNext" list="stepsList" value="${d.next_step||''}" placeholder="Escribe para crear nuevo...">`;
        }
        c.innerHTML = html;
    }

    function addOptRow() { 
        document.getElementById('optsList').insertAdjacentHTML('beforeend', 
            `<div style="display:flex; gap:5px; margin-bottom:5px;">
                <input class="o-lbl" placeholder="Botón">
                <input class="o-nxt" list="stepsList" placeholder="Destino (Nuevo)">
                <button onclick="this.parentElement.remove()" style="color:var(--danger); background:none; border:none;">✕</button>
            </div>`
        ); 
    }

    async function saveStep() {
        const id = document.getElementById('stId').value;
        const type = document.getElementById('stType').value;
        
        // Objeto base
        const data = { type, message: document.getElementById('stMsg').value, media: currentMediaList };
        
        // Array para rastrear qué pasos nuevos debemos crear
        let stepsToCreate = [];

        // 1. Recolectar Next Step (Input/Mensaje/Cita)
        if(document.getElementById('stNext')) {
            const val = document.getElementById('stNext').value.trim().toUpperCase(); // Forzamos mayúsculas
            if(val) {
                data.next_step = val;
                if(!flow[val]) stepsToCreate.push(val);
            }
        }

        // 2. Recolectar Opciones (Menu)
        if(document.getElementById('optsList')) {
            data.options = [];
            document.querySelectorAll('#optsList div').forEach(row => {
                const l = row.querySelector('.o-lbl').value;
                const n = row.querySelector('.o-nxt').value.trim().toUpperCase(); // Forzamos mayúsculas
                if(l && n) {
                    data.options.push({label:l, trigger:l, next_step:n});
                    if(!flow[n]) stepsToCreate.push(n);
                }
            });
        }
        
        // 3. Otros campos
        if(document.getElementById('stVar')) data.save_var = document.getElementById('stVar').value;
        if(document.getElementById('stKw')) data.keywords = document.getElementById('stKw').value.split(',').map(s=>s.trim());
        if(document.getElementById('stAdm')) data.admin_number = document.getElementById('stAdm').value;

        // 👇 AQUÍ ESTÁ LA RECOLECCIÓN DE LOS NUEVOS DATOS DE LA CITA 👇
        if (type === 'cita') {
            data.msg_date = document.getElementById('stCitaDate') ? document.getElementById('stCitaDate').value : '';
            data.msg_time = document.getElementById('stCitaTime') ? document.getElementById('stCitaTime').value : '';
            data.interval = document.getElementById('stCitaInterval') ? document.getElementById('stCitaInterval').value : '30';
        }
        // 👆 FIN DE LA RECOLECCIÓN DE CITAS 👆

        // --- MAGIA: CREACIÓN AUTOMÁTICA DE PASOS ---
        // Si detectamos pasos destino que NO existen, los creamos en el servidor
        if(stepsToCreate.length > 0) {
            // Filtramos duplicados
            stepsToCreate = [...new Set(stepsToCreate)];
            
            for (const newStepName of stepsToCreate) {
                // Solo si realmente no existe en memoria
                if(!flow[newStepName]) {
                    console.log("✨ Creando paso automático:", newStepName);
                    const placeholderData = { type: 'message', message: '🚧 Paso creado automáticamente. Edítame.' };
                    // Guardar en servidor
                    await fetch('/api/flow/step', { 
                        method: 'POST', 
                        headers: {'Content-Type': 'application/json'}, 
                        body: JSON.stringify({ stepId: newStepName, stepData: placeholderData }) 
                    });
                    // Actualizar memoria local
                    flow[newStepName] = placeholderData;
                }
            }
            showToast(`✨ ${stepsToCreate.length} pasos nuevos creados`);
        }

        // --- GUARDADO FINAL DEL PASO ACTUAL ---
        await fetch('/api/flow/step', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ stepId: id, stepData: data }) });
        
        flow[id] = data; 
        renderFlowList(); 
        document.getElementById('editorModal').classList.remove('active');
        showToast("✅ Paso guardado");
    }

    function createNewStepPrompt() {
        document.getElementById('newStepNameInput').value = '';
        document.getElementById('stepNameModal').classList.add('active');
        setTimeout(() => document.getElementById('newStepNameInput').focus(), 100);
    }
    function confirmCreateStep() {
        const n = document.getElementById('newStepNameInput').value.toUpperCase().trim();
        if(!n) return alert("El nombre es requerido");
        if(flow[n]) return alert("Ya existe un paso con ese nombre");
        flow[n] = {type:'message'};
        renderFlowList();
        document.getElementById('stepNameModal').classList.remove('active');
        edit(n);
    }
    async function delStep() { await fetch('/api/flow/step/'+document.getElementById('stId').value, {method:'DELETE'}); delete flow[document.getElementById('stId').value]; renderFlowList(); document.getElementById('editorModal').classList.remove('active'); }

    async function loadKeywords() {
        const container = document.getElementById('keywordsList');
        container.innerHTML = '<div style="text-align:center; padding:20px;"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>';

        try {
            const res = await fetch('/api/keywords');
            const rules = await res.json();

            container.innerHTML = '';

            if (rules.length === 0) {
                container.innerHTML = `
                    <div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-muted); border:1px dashed var(--border); border-radius:10px;">
                        <i class="fas fa-magic" style="font-size:2rem; margin-bottom:10px;"></i><br>
                        No hay reglas creadas.<br>Crea una para responder dudas frecuentes automáticamente.
                    </div>`;
                return;
            }

            rules.forEach(r => {
                const div = document.createElement('div');
                div.style.background = 'var(--bg-input)';
                div.style.padding = '15px';
                div.style.borderRadius = '10px';
                div.style.border = '1px solid var(--border)';
                div.style.position = 'relative';

                // Convertimos "hola, precio" en etiquetas visuales
                const tags = r.keywords.split(',').map(k => 
                    `<span style="background:rgba(59,130,246,0.2); color:#60a5fa; padding:2px 8px; border-radius:4px; font-size:0.8rem; margin-right:5px;">${k.trim()}</span>`
                ).join('');

                div.innerHTML = `
                    <div style="margin-bottom:10px;">${tags}</div>
                    <div style="color:var(--text-main); white-space:pre-wrap; font-size:0.9rem; margin-bottom:15px; padding:10px; background:rgba(0,0,0,0.2); border-radius:6px;">${r.answer}</div>
                    <button onclick="deleteKeyword('${r.id}')" style="position:absolute; top:10px; right:10px; background:none; border:none; color:var(--danger); cursor:pointer;">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
                container.appendChild(div);
            });

        } catch (e) {
            console.error(e);
            container.innerHTML = 'Error cargando reglas.';
        }
    }

    function openKeywordModal() {
        document.getElementById('kwInput').value = '';
        document.getElementById('kwAnswer').value = '';
        document.getElementById('keywordModal').classList.add('active');
    }

    async function saveKeywordRule() {
        const keywords = document.getElementById('kwInput').value.trim();
        const answer = document.getElementById('kwAnswer').value.trim();

        if (!keywords || !answer) return alert("Escribe las palabras clave y la respuesta.");

        try {
            await fetch('/api/keywords', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keywords, answer })
            });
        
            document.getElementById('keywordModal').classList.remove('active');
            showToast("✅ Regla guardada");
            loadKeywords(); // Recargar lista
        } catch (e) {
            alert("Error guardando");
        }
    }

    async function deleteKeyword(id) {
        if(!confirm("¿Borrar esta regla?")) return;
        try {
            await fetch(`/api/keywords/${id}`, { method: 'DELETE' });
            loadKeywords();
            showToast("🗑️ Regla eliminada");
        } catch(e) { console.error(e); }
    }

    async function renderCalendar() {
        const now = currentRefDate, m = now.getMonth(), y = now.getFullYear();
        document.getElementById('monthDisplay').innerText = `${["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"][m]} ${y}`;
        const g = document.getElementById('calendarDays'); 

        let appts = {};
        try { appts = await (await fetch(`${API_BASE}/api/agenda`)).json(); } catch(e){}

        const firstDay = new Date(y, m, 1).getDay(), daysInMonth = new Date(y, m+1, 0).getDate();
        
        // 🚀 EL LIENZO INVISIBLE (BUFFER)
        let htmlBuffer = ''; 
        
        for(let i=0; i<firstDay; i++) htmlBuffer += `<div></div>`;

        for(let i=1; i<=daysInMonth; i++) {
            const k = `${y}-${(m+1).toString().padStart(2,'0')}-${i.toString().padStart(2,'0')}`;
            const count = (appts[k]||[]).length;
            const isToday = new Date().toDateString() === new Date(y,m,i).toDateString();
            htmlBuffer += `<div class="day ${isToday?'today':''}" onclick="openDayModal('${k}')">${i} ${count?`<span class="day-indicator">${count}</span>`:''}</div>`;
        }
        
        // 🚀 PINTAMOS TODO DE UN SOLO GOLPE
        g.innerHTML = htmlBuffer; 
    }

    function changeMonth(d) { currentRefDate.setMonth(currentRefDate.getMonth()+d); renderCalendar(); }

    async function openDayModal(date) {
        document.getElementById('modalDateTitle').innerText = date;
        const list = document.getElementById('modalApptList');
        list.innerHTML = 'Cargando...';

        const all = await (await fetch(`${API_BASE}/api/agenda`)).json();
        const appts = all[date] || [];

        // 🚀 BUFFER
        let htmlBuffer = appts.length ? '' : '<div style="text-align:center; padding:20px; color:#666;">Sin citas</div>';

        appts.sort((a,b)=>a.time.localeCompare(b.time)).forEach(c => {
            const safeName = (c.name || '').replace(/'/g, "\\'");
            htmlBuffer += `
            <div style="background:var(--bg-input); padding:10px; margin-bottom:5px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <b>${c.time}</b> ${c.name} <br>
                    <small style="color:var(--text-muted);">${c.phone}</small>
                </div>
                <button style="color:var(--danger); background:none; border:none; cursor:pointer; padding:5px;"
                        onclick="askDeleteAppt('${date}', '${c.time}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>`;
        });
        
        // 🚀 PINTAMOS UNA VEZ
        list.innerHTML = htmlBuffer;

        document.getElementById('evtOldTime').dataset.date = date;
        document.getElementById('dayModal').classList.add('active');
    }

    function askDeleteAppt(date, time) {
        apptToDelete = { date, time };
        document.getElementById('delApptTimeLbl').innerText = time;
        document.getElementById('deleteApptModal').classList.add('active');
    }

    async function executeDeleteAppt() {
        if(!apptToDelete) return;
        await fetch(`${API_BASE}/api/agenda/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(apptToDelete) });
        document.getElementById('deleteApptModal').classList.remove('active');
        openDayModal(apptToDelete.date);
        renderCalendar();
        showToast('Cita eliminada');
    }

    async function saveEvent() {
        const d = {
            date: document.getElementById('evtOldTime').dataset.date,
            time: document.getElementById('evtTime').value,
            name: document.getElementById('evtName').value,
            phone: document.getElementById('evtPhone').value,
            note: document.getElementById('evtNote').value
        };
        if(!d.time || !d.name) return alert("Faltan datos");
        await fetch(`${API_BASE}/api/agenda/book`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d) });
        document.getElementById('eventForm').style.display='none';
        document.getElementById('btnAddEvent').style.display='block';
        openDayModal(d.date);
        renderCalendar();
    }

    function toggleSchedulerUI() {
        const isActive = document.getElementById('schActive').checked;
        const configDiv = document.getElementById('schedulerConfig');
        const statusText = document.getElementById('schedStatusText');

        if (isActive) {
            configDiv.style.display = 'block';
            statusText.innerText = 'Activado · Se ejecutará diariamente';
            statusText.style.color = 'var(--success)';
        } else {
            configDiv.style.display = 'none';
            statusText.innerText = 'Desactivado';
            statusText.style.color = 'var(--text-muted)';
        }
    }

    async function loadSchedulerConfig() {
        try {
            const select = document.getElementById('schStepSelect');
            // Guardamos el valor actual por si ya estaba seleccionado algo y no queremos perderlo al repintar
            const currentVal = select.value; 
            
            select.innerHTML = '<option value="">-- Selecciona un paso --</option>';
            Object.keys(flow).sort().forEach(stepKey => {
                const opt = document.createElement('option');
                opt.value = stepKey;
                opt.innerText = stepKey;
                select.appendChild(opt);
            });

            const settings = await (await fetch(`${API_BASE}/api/settings`)).json();
            
            if (settings.scheduler) {
                document.getElementById('schActive').checked = settings.scheduler.active || false;
                document.getElementById('schTime').value = settings.scheduler.time || "09:00";
                if (settings.scheduler.target_step) {
                    select.value = settings.scheduler.target_step;
                }
            }
            
            // 🔥 IMPORTANTE: Actualizamos la UI inicial
            toggleSchedulerUI();

        } catch (e) {
            console.error("Error scheduler config", e);
        }
    }

    async function saveSchedulerConfig() {
        const active = document.getElementById('schActive').checked;
        const time = document.getElementById('schTime').value;
        const targetStep = document.getElementById('schStepSelect').value;

        if (active && (!time || !targetStep)) {
            return; 
        }

        const payload = {
            scheduler: {
                active: active,
                time: time,
                target_step: targetStep,
                last_run: "" // Opcional
            }
        };

        try {
            await fetch(`${API_BASE}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            // Feedback sutil
            showToast("💾 Configuración guardada");
        } catch (e) {
            showToast("Error al guardar");
        }
    }

    // --- CONTACTOS Y UTILIDADES ---
    let phoneToDelete = null;
    let isEditingMode = false;

    async function editCurrentContactManual() {
        if (!currentChatPhone) return;

        // 1. Obtener datos actuales
        const currentName = document.getElementById('waHeaderName').innerText;

        // 2. Pedir nuevo nombre
        const newName = prompt("📝 Editar nombre del cliente:", currentName);
    
        // Si cancela o lo deja vacío, no hacemos nada
        if (!newName || newName.trim() === "") return;

        // 3. Enviar al servidor (Backend)
        // Nota: Usamos el endpoint '/api/contacts/update' que debes tener en tu backend
        try {
                const response = await fetch(`${API_BASE}/api/contacts/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: currentChatPhone, // El ID no cambia
                    name: newName,           // El nombre sí cambia
                    enable: document.getElementById('waBotSwitch').checked // Mantenemos el estado del bot
                })
            });

            const res = await response.json();

            if (res.success || response.ok) {
                // 4. Actualizar visualmente al instante
                document.getElementById('waHeaderName').innerText = newName;

                // Actualizamos la lista lateral también
                const u = users.find(x => getCleanPhone(x.phone) === getCleanPhone(currentChatPhone));
                if(u) {
                    u.savedName = newName; // Actualizar memoria local
                    if(u.history) u.history.nombre = newName;
                }
                renderChatList(users);

                showToast("✅ Nombre actualizado");
            } else {
                alert("Error al guardar en el servidor");
            }
        } catch (e) {
            console.error(e);
            showToast("❌ Error de conexión");
        }
    }

    function openContactModal() {
        isEditingMode = false;
        document.getElementById('modalTitleContact').innerText = "Nuevo Contacto";
        document.getElementById('newContName').value = '';
        document.getElementById('newContPhone').value = '';
        document.getElementById('newContPhone').disabled = false;
        document.getElementById('newContPhone').style.opacity = "1";
        document.getElementById('newContEnable').checked = true;
        document.getElementById('contactModal').classList.add('active');
    }

    async function saveNewContact() {
        const name = document.getElementById('newContName').value;
        const phone = document.getElementById('newContPhone').value;
        const enable = document.getElementById('newContEnable').checked;
        if(!phone) return alert("Teléfono obligatorio");
        const endpoint = isEditingMode ? '/api/contacts/update' : '/api/contacts/add';
        await fetch(`${API_BASE}${endpoint}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, phone, enable}) });
        document.getElementById('contactModal').classList.remove('active');
        showToast(isEditingMode ? 'Contacto actualizado' : 'Contacto creado');
        loadActivity(); // Actualizar monitor
    }

    function askDelete(phone, name) {
        phoneToDelete = phone;
        document.getElementById('delContactName').innerText = name || phone;
        document.getElementById('deleteConfirmModal').classList.add('active');
    }

    // --- LÓGICA VISUAL DE BARRA WHATSAPP ---

    function handleInputTyping() {
        const inp = document.getElementById('waInput');
        const pill = document.getElementById('waInputPill');
        const btn = document.getElementById('waMainBtn');
        const icon = document.getElementById('waMainIcon');
        
        const text = inp.value; // No usamos trim() aquí para detectar espacios también

        if (text.length > 0) {
            // ESTADO: ESCRIBIENDO
            if (!pill.classList.contains('typing')) {
                pill.classList.add('typing'); // Oculta iconos
                
                // Cambiar Micrófono -> Avión
                btn.classList.add('is-send');
                icon.className = 'fas fa-paper-plane';
                // Pequeña animación de entrada
                icon.style.transform = 'scale(0)';
                setTimeout(() => icon.style.transform = 'scale(1)', 50);
            }
        } else {
            // ESTADO: VACÍO
            if (pill.classList.contains('typing')) {
                pill.classList.remove('typing'); // Muestra iconos
                
                // Cambiar Avión -> Micrófono
                btn.classList.remove('is-send');
                icon.className = 'fas fa-microphone';
                icon.style.transform = 'scale(0)';
                setTimeout(() => icon.style.transform = 'scale(1)', 50);
            }
        }
    }

    // Maneja el clic en el botón grande
    function handleMainBtn() {
        const icon = document.getElementById('waMainIcon');
        
        // Si es el avión de papel, enviamos
        if (icon.classList.contains('fa-paper-plane')) {
            sendWaMsg();
            // Reseteamos la vista manualmente después de enviar
            document.getElementById('waInputPill').classList.remove('typing');
            document.getElementById('waMainBtn').classList.remove('is-send');
            document.getElementById('waMainIcon').className = 'fas fa-microphone';
        } else {
            // Si es micrófono
            showToast("🎤 Grabación de voz no disponible");
        }
    }

    async function executeDelete() {
        if(!phoneToDelete) return;
        await fetch(`${API_BASE}/api/contacts/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone: phoneToDelete}) });
        allContactsCache = allContactsCache.filter(u => u.phone !== phoneToDelete);
        document.getElementById('deleteConfirmModal').classList.remove('active');
        loadActivity(); // Refrescar
        showToast('Contacto eliminado');
    }

    function formatSmartDate(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return ''; // Valida que sea una fecha real

        const now = new Date();
        // Normalizamos las fechas eliminando las horas para hacer una resta exacta de días
        const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        // Calculamos la diferencia en días
        const diffTime = today.getTime() - msgDate.getTime();
        const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

        if (diffDays === 0) {
            // Es hoy: mostrar solo la hora (ej: 14:30)
            return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
        } else if (diffDays === 1) {
            // Fue ayer
            return 'Ayer';
        } else if (diffDays > 1 && diffDays < 7) {
            // Hace menos de una semana: mostrar el día de la semana
            const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
            return dias[date.getDay()];
        } else {
            // Más antiguo: mostrar fecha corta (ej: 25/02/2026)
            return date.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
        }
    }

    // --- NAVEGACIÓN Y MENÚ ---
    function toggleMenu() { 
        document.getElementById('sidebar').classList.toggle('active'); 
        document.getElementById('sidebarOverlay').classList.toggle('active'); 
    }

    function nav(v, btn) {
        if(v !== 'activity' && typeof closeWaChat === 'function') closeWaChat();
        
        document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
        document.querySelectorAll('.menu-item').forEach(e => e.classList.remove('active'));
        
        const targetView = document.getElementById('view-'+v);
        if(targetView) targetView.classList.add('active');
        if(btn) btn.classList.add('active');
        
        document.getElementById('sidebar').classList.remove('active');
        document.getElementById('sidebarOverlay').classList.remove('active');

        // --- CARGADORES DE CADA VISTA ---
        
        // 1. Si es Monitor
        if(v === 'activity') loadActivity();
        
        // 2. Si es Respuestas
        if(v === 'keywords') loadKeywords();
        
        // 3. Si es Agenda (AQUÍ ESTABA EL ERROR, AHORA ESTÁ UNIFICADO)
        if(v === 'agenda') {
            renderCalendar();       // Carga el calendario UNA sola vez
            loadSchedulerConfig();  // Carga la configuración del bot
        }

        // --- TÍTULOS ---
        const titles = { 
            activity:'MONITOR', 
            flow:'FLUJO', 
            agenda:'AGENDA', 
            settings:'AJUSTES',
            keywords: 'RESPUESTAS RÁPIDAS',
            config: 'CONFIGURACIÓN'
        };
        
        const titleEl = document.getElementById('pageTitle');
        if(titleEl) titleEl.innerText = titles[v] || 'CRM';
    }

    function requestLogout() {
        document.getElementById('sidebar').classList.remove('active');
        document.getElementById('sidebarOverlay').classList.remove('active');
        document.getElementById('logoutModal').classList.add('active');
    }
    async function confirmLogout() {
        await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
        location.reload();
    }

    function toggleSettingsUI() {
        const isActive = document.getElementById('schedActive').checked;
        const configDiv = document.getElementById('settingsConfig');
        const statusText = document.getElementById('settingsStatusText');

        if (isActive) {
            configDiv.style.display = 'block';
            statusText.innerText = 'Activado · El bot responderá fuera de horario';
            statusText.style.color = 'var(--success)';
        } else {
            configDiv.style.display = 'none';
            statusText.innerText = 'Respuesta automática apagada';
            statusText.style.color = 'var(--text-muted)';
        }
    }

    async function saveSettings() {
        const active = document.getElementById('schedActive').checked;
        const start = document.getElementById('schedStart').value;
        const end = document.getElementById('schedEnd').value;
        const msg = document.getElementById('schedMsg').value;

        // Validación básica (solo si está activo)
        if (active && (!start || !end || !msg)) {
            // No guardamos si faltan datos críticos al activarlo
            return;
        }

        const s = { 
            active: active, 
            start: start, 
            end: end, 
            offline_message: msg 
        };

        try {
            await fetch(`${API_BASE}/api/settings`, {
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body:JSON.stringify({schedule:s})
            });
            showToast('💾 Horario guardado');
        } catch(e) {
            showToast('Error al guardar');
        }
    }

    function showToast(m) { 
        const c = document.getElementById('toast-container'); 
        if(c) {
            c.innerHTML += `<div class="toast">${m}</div>`; 
            setTimeout(() => { if(c.lastChild) c.lastChild.remove(); }, 3000); 
        }
    }
    
    // --- PUSH Y MOVE USER ---
    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    async function registerPush() {
        if ('serviceWorker' in navigator && 'PushManager' in window) {
            try {
                const response = await fetch('/api/vapid-key');
                const { key } = await response.json();
                const registration = await navigator.serviceWorker.ready;
                const subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(key)
                });
                await fetch('/api/subscribe', {
                    method: 'POST',
                    body: JSON.stringify(subscription),
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) { console.error('Error Push', error); }
        }
    }

    let userToMove = null;
    function openMoveModal(phone, currentStep) {
        userToMove = phone;
        document.getElementById('moveUserPhoneLbl').innerText = phone;
        const select = document.getElementById('moveStepSelect');
        select.innerHTML = getSelectOptions(currentStep);
        document.getElementById('moveUserModal').classList.add('active');
    }

    async function executeMoveUser() {
        const targetStep = document.getElementById('moveStepSelect').value;
        if (!userToMove || !targetStep) return;
        try {
            await fetch(`${API_BASE}/api/crm/execute`, {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ phone: userToMove, stepId: targetStep })
            });
            showToast(`Cliente movido a ${targetStep}`);
            document.getElementById('moveUserModal').classList.remove('active');
            loadActivity();
        } catch (e) { alert("Error al mover"); }
    }

    // --- 1. SUBIDA DE IMÁGENES (EDITOR DE FLUJOS) ---
    async function uploadImages(input) {
        if (!input.files || input.files.length === 0) return;
        
        const formData = new FormData();
        // Empaquetamos todas las imágenes seleccionadas
        for (let i = 0; i < input.files.length; i++) {
            formData.append('images', input.files[i]);
        }

        showToast("⏳ Subiendo imagen...");

        try {
            // Mandamos las fotos a tu endpoint backend (/api/upload)
            const res = await fetch(`${API_BASE}/api/upload`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.urls) {
                // Guardamos las rutas de las fotos y actualizamos la vista
                currentMediaList = currentMediaList.concat(data.urls);
                renderGallery();
                showToast("✅ Imagen guardada con éxito");
            }
        } catch (e) {
            console.error("Error al subir:", e);
            showToast("❌ Error al subir la imagen");
        } finally {
            input.value = ''; // Limpiamos el botón para que puedas subir más
        }
    }

    async function uploadChatMedia(input) {
        if (!input.files || input.files.length === 0) return;
        if (!currentChatPhone) {
            showToast("⚠️ Selecciona un chat primero");
            input.value = '';
            return;
        }

        const captionText = document.getElementById('waInput').value.trim();

        const formData = new FormData();
        formData.append('images', input.files[0]); // Solo mandamos 1 foto a la vez en el chat

        showToast("⏳ Enviando imagen...");

        try {
            // 1. Subimos la foto al servidor usando tu ruta existente
            const resUpload = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
            const dataUpload = await resUpload.json();

            if (dataUpload.urls && dataUpload.urls.length > 0) {
                const imageUrl = dataUpload.urls[0];
                
                // 2. Le decimos al servidor que la envíe por WhatsApp
                await fetch(`${API_BASE}/api/send-message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        phone: currentChatPhone, 
                        text: captionText, 
                        mediaUrl: imageUrl 
                    })
                });

                // Limpiamos la caja de texto y mostramos la burbuja
                document.getElementById('waInput').value = '';
                addBubble(`📷 Imagen enviada ${captionText ? '- ' + captionText : ''}`, true);
                showToast("✅ Imagen enviada");
                
                // Reseteamos los iconos del input
                handleInputTyping();
            }
        } catch (e) {
            console.error("Error al enviar multimedia:", e);
            showToast("❌ Error al enviar la imagen");
        } finally {
            input.value = ''; 
        }
    }

    // --- MODO OSCURO ---
    function toggleDarkMode(isDark) {
        const statusText = document.getElementById('darkModeStatusText');
        
        if (isDark) {
            document.body.classList.add('dark-mode');
            if(statusText) statusText.innerText = 'Activado';
            localStorage.setItem('theme', 'dark');
        } else {
            document.body.classList.remove('dark-mode');
            if(statusText) statusText.innerText = 'Apagado';
            localStorage.setItem('theme', 'light');
        }
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;")
                  .replace(/'/g, "&#039;");
    }

    // Lógica para PWA
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const btn = document.getElementById('installAppBtn');
        if(btn) btn.style.display = 'flex';
    });

    function installPWA() {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('Usuario aceptó instalar');
                document.getElementById('installAppBtn').style.display = 'none';
            }
            deferredPrompt = null;
        });
    }

    window.addEventListener('hashchange', () => {
        if (window.location.hash === '#agenda') nav('agenda');
        if (window.location.hash === '#activity') nav('activity');
    });

    window.addEventListener('load', () => { setTimeout(registerPush, 2000); });
