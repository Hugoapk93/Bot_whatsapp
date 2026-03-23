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

    // --- VARIABLES PARA RESPUESTAS Y MULTIMEDIA ---
    let currentEditKwId = null;
    let pendingMediaFile = null;

    // --- SOCKET.IO ---
    const socket = io({ reconnection: true });
    socket.on('connect', () => { updateConnStatus(true); loadActivity(); });
    socket.on('disconnect', () => { updateConnStatus(false); });

    socket.on('message', (data) => {
        // 1. Extraer el texto real
        let realText = data.text || data.body || data.caption || data.message || '';
        
        // Soporte extra
        if(!realText && data.extendedTextMessage) realText = data.extendedTextMessage.text;
        if(!realText && data.conversation) realText = data.conversation;
        if(!realText && data.imageMessage) realText = data.imageMessage.caption || '';
        if(!realText && data.videoMessage) realText = data.videoMessage.caption || '🎥 Video';

        const targetPhoneKey = String(data.phone || data.from || data.to || '').replace(/\D/g, '');
        if (targetPhoneKey && typeof users !== 'undefined' && users.length > 0) {
            const userMem = users.find(u => {
                const cleanPhone = String(u.phone).replace(/\D/g, '');
                const cleanDb = u.realDbPhone ? String(u.realDbPhone).replace(/\D/g, '') : '';
                return cleanPhone === targetPhoneKey || cleanDb === targetPhoneKey;
            });
            
            if (userMem) {
                if (!userMem.messages) userMem.messages = [];
                userMem.messages.push({
                    text: realText,
                    fromMe: data.fromMe,
                    stepId: data.stepId || null,
                    timestamp: new Date().toISOString(),
                    mediaUrl: data.mediaUrl || null
                });

                userMem.last_message = realText || (data.mediaUrl ? '📷 Imagen' : '');
                userMem.last_active = new Date().toISOString();
                if (data.stepId) userMem.current_step = data.stepId;
            }

            filterChats(currentSearchQuery);
        }

        if (currentChatPhone) {
            const currentKey = String(currentChatPhone).replace(/\D/g, ''); 
            const msgFromKey = String(data.from || data.phone || '').replace(/\D/g, ''); 
            const msgToKey   = String(data.to || data.phone || '').replace(/\D/g, '');    

            let isMatch = (currentKey === msgFromKey || currentKey === msgToKey);

            if (!isMatch && typeof users !== 'undefined' && users.length > 0) {
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

            if (isMatch) {
                 if(realText || data.mediaUrl) {
                     addBubble(realText, data.fromMe, null, new Date().toISOString(), data.mediaUrl);
                 }
            }
        }
    });

    socket.on('user_update', (data) => {
        const targetPhone = getCleanPhone(data.phone);
        const userIndex = users.findIndex(u => getCleanPhone(u.phone) === targetPhone);

        if (userIndex !== -1) {
            users[userIndex] = { ...users[userIndex], ...data };
            if (data.name) {
                users[userIndex].savedName = data.name;
                if (!users[userIndex].history) users[userIndex].history = {};
                users[userIndex].history.nombre = data.name;
            }
        }

        renderChatList(users);

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
            users.unshift(newUser); 
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
                    else if (window.location.hash.startsWith('#activity')) {
                        const hash = window.location.hash;
                        nav('activity');
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
            
            if(s.timezone) { document.getElementById('botTimezone').value = s.timezone; }

            if(typeof previewTimezone === 'function') previewTimezone();

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

            if (currentChatPhone) {
                const updatedUser = users.find(u => getCleanPhone(u.phone) === getCleanPhone(currentChatPhone));
                if(updatedUser) {
                    const switchEl = document.getElementById('waBotSwitch');
                    if(switchEl) switchEl.checked = updatedUser.bot_enabled;
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
            
            const name = u.savedName || u.history?.nombre || u.history?.cliente || u.history?.usuario || u.phone;
            const timeDisplay = formatSmartDate(u.last_active);
            
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
                if (ignoreClick) { ignoreClick = false; return; }
                if (isSelectionMode) { toggleSelection(u.phone); } 
                else { openWaChat(u.phone); }
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
            filterChats(currentSearchQuery); 
        }
    }

    function exitSelectionMode() {
        isSelectionMode = false;
        selectedChats = [];
        document.getElementById('waHeaderSearch').style.display = 'block';
        document.getElementById('waHeaderSelection').style.display = 'none';
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
                msgs.forEach(m => addBubble(m.text, m.fromMe, m.stepId, m.timestamp, m.mediaUrl));
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
                newMsgs.forEach(m => addBubble(m.text, m.fromMe, m.stepId, m.timestamp, m.mediaUrl));
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

    // --- SUBIDA Y VISTA PREVIA DE IMÁGENES ---
    async function uploadImages(input) {
        if (!input.files || input.files.length === 0) return;
        
        const formData = new FormData();
        for (let i = 0; i < input.files.length; i++) {
            formData.append('images', input.files[i]);
        }
        showToast("⏳ Subiendo imagen...");

        try {
            const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.urls) {
                currentMediaList = currentMediaList.concat(data.urls);
                renderGallery();
                showToast("✅ Imagen guardada con éxito");
            }
        } catch (e) {
            console.error("Error al subir:", e);
            showToast("❌ Error al subir la imagen");
        } finally {
            input.value = ''; 
        }
    }

    function uploadChatMedia(input) {
        if (!input.files || input.files.length === 0) return;
        if (!currentChatPhone) {
            showToast("⚠️ Selecciona un chat primero");
            input.value = '';
            return;
        }

        pendingMediaFile = input.files[0];
        const reader = new FileReader();
        reader.onload = function(e) {
            showMediaPreviewModal(e.target.result);
        };
        reader.readAsDataURL(pendingMediaFile);
        
        input.value = ''; 
    }
    
    function showMediaPreviewModal(dataUrl) {
        let modal = document.getElementById('mediaPreviewModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'mediaPreviewModal';
            modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(11,20,26,0.95); z-index:9999; display:none; flex-direction:column; justify-content:center; align-items:center;';
            modal.innerHTML = `
                <div style="width:100%; max-width:500px; display:flex; flex-direction:column; height:100vh;">
                    <div style="padding:15px; display:flex; justify-content:flex-start;">
                        <button onclick="closeMediaPreview()" style="background:none; border:none; color:white; font-size:1.5rem; cursor:pointer;"><i class="fas fa-times"></i></button>
                    </div>
                    <div style="flex:1; display:flex; justify-content:center; align-items:center; padding:20px; overflow:hidden;">
                        <img id="mediaPreviewImg" src="" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:10px;">
                    </div>
                    
                    <div class="wa-input-area" style="padding-bottom: 25px;">
                        <div class="wa-input-pill" style="padding-left: 20px;">
                            <input type="text" id="mediaPreviewCaption" placeholder="Añade un comentario..." 
                                   onkeypress="if(event.key==='Enter') sendPendingMedia()" 
                                   style="flex:1; background:transparent; border:none; outline:none; padding:0 10px 0 0; font-size:16px; width:100%; color:var(--text-main);">
                        </div>
                        <button onclick="sendPendingMedia()" class="wa-main-btn">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="transform: translateX(2px);"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>
                        </button>
                    </div>

                </div>
            `;
            document.body.appendChild(modal);
        }
        
        document.getElementById('mediaPreviewImg').src = dataUrl;
        document.getElementById('mediaPreviewCaption').value = document.getElementById('waInput').value; 
        modal.style.display = 'flex'; 
        setTimeout(() => document.getElementById('mediaPreviewCaption').focus(), 100);
    }

    function closeMediaPreview() {
        pendingMediaFile = null;
        document.getElementById('mediaPreviewModal').style.display = 'none';
    }

    async function sendPendingMedia() {
        if (!pendingMediaFile || !currentChatPhone) return;
        
        const captionText = document.getElementById('mediaPreviewCaption').value.trim();
        const formData = new FormData();
        formData.append('images', pendingMediaFile);

        closeMediaPreview(); 
        showToast("⏳ Enviando imagen...");

        try {
            const resUpload = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
            const dataUpload = await resUpload.json();

            if (dataUpload.urls && dataUpload.urls.length > 0) {
                const imageUrl = dataUpload.urls[0];
                
                await fetch(`${API_BASE}/api/send-message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: currentChatPhone, text: captionText, mediaUrl: imageUrl })
                });

                document.getElementById('waInput').value = '';
                handleInputTyping();
            }
        } catch (e) {
            showToast("❌ Error al enviar la imagen");
        }
    }

    function addBubble(text, isMe, stepId, timestamp, mediaUrl = null) {
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

        let mediaHtml = '';
        if (mediaUrl) {
            mediaHtml = `<div style="margin-bottom: 5px;"><img src="${mediaUrl}" style="max-width: 100%; border-radius: 8px; cursor: pointer;" onclick="window.open('${mediaUrl}', '_blank')"></div>`;
        }

        const html = `<div class="wa-bubble ${isMe ? 'out' : 'in'} ${canClick ? 'clickable' : ''}" ${canClick ? `onclick="askJump('${safeStepId}')"` : ''} title="${canClick ? 'Click para restaurar' : ''}">${mediaHtml}${safeText}<span class="wa-time">${timeStr}</span></div>`;

        const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
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

        inp.value = '';
        handleInputTyping();
        document.getElementById('waFlowDrawer').classList.remove('open'); 

        if (txt.startsWith('>> ')) {
            const targetStep = txt.replace('>> ', '').trim();
            addBubble(`🔄 <i>Forzando paso: ${targetStep}</i>`, true);

            const qrContainer = document.getElementById('waQuickReplies');
            if (qrContainer) {
                qrContainer.innerHTML = '';
                qrContainer.style.display = 'none';
            }

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
        currentSearchQuery = q; 
        if(!q) {
            renderChatList(users);
        } else {
            const term = q.toLowerCase();
            const f = users.filter(u => {
                const str = JSON.stringify(u).toLowerCase(); 
                const savedName = (u.savedName || '').toLowerCase();
                return str.includes(term) || savedName.includes(term);
            });
            renderChatList(f);
        }
    }

    function handleInputTyping() {
        const inp = document.getElementById('waInput');
        const iconsToHide = document.querySelectorAll('.hide-on-type');
        const btn = document.getElementById('waMainBtn');
        
        if (!inp || !btn) return;

        if (inp.value.length > 0) {
            // Ocultamos el clip
            iconsToHide.forEach(el => el.style.display = 'none');
            btn.classList.add('is-send');
            
            // Dibujamos la flecha exacta
            btn.innerHTML = `<svg id="waMainIcon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="transform: translateX(2px);"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>`;
        } else {
            // Volvemos a mostrar el clip
            iconsToHide.forEach(el => el.style.display = 'inline-block');
            btn.classList.remove('is-send');
            
            // Volvemos al micrófono
            btn.innerHTML = `<i class="fas fa-microphone" id="waMainIcon"></i>`;
        }
    }

    function handleMainBtn() {
        const btn = document.getElementById('waMainBtn');
        if (btn && btn.classList.contains('is-send')) {
            sendWaMsg(); // Si es una flecha, enviamos el mensaje
        } else { 
            showToast("🎤 Grabación de voz no disponible"); // Si es micrófono
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

        document.getElementById('jumpModal').classList.remove('active');
        showToast("🔄 Procesando...");

        const qrContainer = document.getElementById('waQuickReplies');
        if (qrContainer) {
            qrContainer.innerHTML = '';
            qrContainer.style.display = 'none';
        }

        try {
            await fetch(`${API_BASE}/api/crm/execute`, {
                method:'POST', 
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ phone: currentChatPhone, stepId: pendingJumpStep })
            });

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

        const qrContainer = document.getElementById('waQuickReplies');
        if (qrContainer) {
            qrContainer.innerHTML = '';
            qrContainer.style.display = 'none';
        }

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

    // --- FLUJO Y EDITOR (ACTUALIZADO CON TABS) ---
    let flowPath = [];

    // 🔥 NUEVA FUNCION: Manejar las pestañas del editor
    function switchTab(tab) {
        document.getElementById('tabBtn-main').classList.remove('active');
        document.getElementById('tabBtn-errors').classList.remove('active');
        document.getElementById('tabBtn-' + tab).classList.add('active');
        
        document.getElementById('tabContent-main').style.display = 'none';
        document.getElementById('tabContent-errors').style.display = 'none';
        document.getElementById('tabContent-' + tab).style.display = 'block';
    }

    function renderFlowList() {
        const c = document.getElementById('flowListContainer');
        if(!c) return;

        let htmlBuffer = '';

        if (flowPath.length > 0) {
            let navHtml = `<div class="flow-nav" id="breadcrumbNav">`;
            navHtml += `<button onclick="jumpToStep(${flowPath.length - 2})" class="admin-btn" style="border-radius:50%; width:30px; height:30px; display:flex; align-items:center; justify-content:center; padding:0; flex-shrink:0;"><i class="fas fa-arrow-left"></i></button>`;
            
            navHtml += `<span onclick="resetFlowNav()">Inicio</span>`;
            flowPath.forEach((step, index) => {
                const isLast = index === flowPath.length - 1;
                navHtml += ` <i class="fas fa-chevron-right" style="font-size:0.7rem; opacity:0.5;"></i> 
                             <span onclick="${isLast ? '' : `jumpToStep(${index})`}" style="${isLast ? 'font-weight:bold; color:var(--text-main)' : ''}">${step}</span>`;
            });
            navHtml += `</div>`;
            htmlBuffer += navHtml; 
        }

        let stepsToShow = [];
        if (flowPath.length === 0) {
            stepsToShow = findFlowRoots(); 
            if(stepsToShow.length === 0 && Object.keys(flow).length > 0) {
                stepsToShow = [Object.keys(flow).sort()[0]];
            }
        } else {
            const currentStep = flowPath[flowPath.length - 1];
            stepsToShow = [currentStep];
        }

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

            let chipsHtml = '';
            
            if(step.options && step.options.length > 0) {
                step.options.forEach(opt => {
                    chipsHtml += `<div class="flow-chip" onclick="event.stopPropagation(); enterStep('${opt.next_step}')">
                        <span>${opt.label}</span> <i class="fas fa-arrow-right"></i>
                    </div>`;
                });
            }
            else if (step.next_step) {
                chipsHtml = `<div class="flow-chip" onclick="event.stopPropagation(); enterStep('${step.next_step}')">
                    <span>Ir a: ${step.next_step}</span> <i class="fas fa-arrow-right"></i>
                </div>`;
            } else {
                 chipsHtml = `<div style="text-align:center; padding:10px; opacity:0.5; font-size:0.8rem;">🏁 Fin del flujo</div>`;
            }

            const cleanText = (step.message || '').trim() || '<span style="font-style:italic; opacity:0.5">(Sin texto)</span>';

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
                <div class="card-footer">${chipsHtml}</div>
            </div>`;
        });

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

    function getLinearFlowSequence() {
        const steps = Object.keys(flow);
        if(steps.length === 0) return [];
        
        let seq = [];
        let curr = 'BIENVENIDA'; 
        if(!flow[curr]) curr = steps[0]; 

        let safety = 0;
        
        while(curr && flow[curr] && safety < 100) {
            if(!seq.includes(curr)) seq.push(curr);
            let next = flow[curr].next_step;
            if(!next && flow[curr].options && flow[curr].options.length > 0) {
                next = flow[curr].options[0].next_step;
            }
            if(seq.includes(next)) break; 
            curr = next;
            safety++;
        }

        steps.forEach(s => {
            if(!seq.includes(s)) seq.push(s);
        });
        return seq;
    }

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
        if(currentIndex === -1) currentIndex = -1;

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

        setTimeout(() => {
            const currentEl = drawer.querySelector('.current');
            if(currentEl) {
                currentEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }, 100);
    }

    function injectStepCommand(stepId) {
        const inp = document.getElementById('waInput');
        inp.value = `>> ${stepId}`; 
        handleInputTyping(); 
        inp.focus();
        toggleFlowDrawer(); 
    }

    let currentMediaList = [];

    function edit(id) {
        const d = flow[id]; 
        document.getElementById('stId').value = id; 
        document.getElementById('stType').value = d.type;
        document.getElementById('stMsg').value = d.message || '';
        
        currentMediaList = d.media || [];
        renderGallery(); 
        renderFields(); 

        // Cargar datos de la pestaña Errores (1, 2 y 3)
        const err1El = document.getElementById('stErrMsg1');
        if(err1El) err1El.value = d.error_message_1 || '';

        const err2El = document.getElementById('stErrMsg2');
        if(err2El) err2El.value = d.error_message_2 || '';

        const err3El = document.getElementById('stErrMsg3');
        if(err3El) err3El.value = d.error_message_3 || '';
        
        const fallbackEl = document.getElementById('stFallbackStep');
        if(fallbackEl) fallbackEl.value = d.fallback_step || '';

        // Siempre abrir en la principal
        switchTab('main'); 
        
        document.getElementById('editorModal').classList.add('active');
    }
    
    // 🔥 ACTUALIZADO PARA USAR EL DISEÑO NUEVO DE FOTOS (THUMB-WRAP)
    function renderGallery() {
        const c = document.getElementById('galleryContainer'); 
        c.innerHTML = '';
        currentMediaList.forEach((u, i) => {
            c.innerHTML += `
            <div class="thumb-wrap">
                <img src="${u}">
                <button onclick="currentMediaList.splice(${i},1); renderGallery()" class="del-thumb"><i class="fas fa-times"></i></button>
            </div>`;
        });
    }

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
        const wrapMsg = document.getElementById('wrapper-msg');
        const tabErrorsBtn = document.getElementById('tabBtn-errors');
        if (tabErrorsBtn) {
            if (type === 'menu' || type === 'input') {
                tabErrorsBtn.style.display = 'inline-block';
            } else {
                tabErrorsBtn.style.display = 'none';
                switchTab('main'); // Forzamos el regreso a la principal por si estaba en Errores
            }
        }

        wrapMsg.style.display = type === 'cita' ? 'none' : 'block'; 

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
            html += `<label>Variable a Guardar (ej: nombre, fecha_nacimiento, correo)</label><input id="stVar" value="${d.save_var||''}">`;
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
        
        const fbEl = document.getElementById('stFallbackStep');
        if(fbEl) fbEl.setAttribute('list', 'stepsList');
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
        
        const data = { 
            type, 
            message: document.getElementById('stMsg').value, 
            media: currentMediaList 
        };
        
        let stepsToCreate = [];

        // Leer datos de los 3 errores
        const err1El = document.getElementById('stErrMsg1');
        if(err1El && err1El.value.trim() !== '') data.error_message_1 = err1El.value.trim();

        const err2El = document.getElementById('stErrMsg2');
        if(err2El && err2El.value.trim() !== '') data.error_message_2 = err2El.value.trim();

        const err3El = document.getElementById('stErrMsg3');
        if(err3El && err3El.value.trim() !== '') data.error_message_3 = err3El.value.trim();
        
        const fbStepEl = document.getElementById('stFallbackStep');
        if(fbStepEl && fbStepEl.value.trim() !== '') {
            const fbVal = fbStepEl.value.trim().toUpperCase();
            data.fallback_step = fbVal;
            if(!flow[fbVal]) stepsToCreate.push(fbVal); // Crear el paso de error si no existe
        }

        if(document.getElementById('stNext')) {
            const val = document.getElementById('stNext').value.trim().toUpperCase(); 
            if(val) {
                data.next_step = val;
                if(!flow[val]) stepsToCreate.push(val);
            }
        }

        if(document.getElementById('optsList')) {
            data.options = [];
            document.querySelectorAll('#optsList div').forEach(row => {
                const l = row.querySelector('.o-lbl').value;
                const n = row.querySelector('.o-nxt').value.trim().toUpperCase(); 
                if(l && n) {
                    data.options.push({label:l, trigger:l, next_step:n});
                    if(!flow[n]) stepsToCreate.push(n);
                }
            });
        }
        
        if(document.getElementById('stVar')) data.save_var = document.getElementById('stVar').value;
        if(document.getElementById('stKw')) data.keywords = document.getElementById('stKw').value.split(',').map(s=>s.trim());
        if(document.getElementById('stAdm')) data.admin_number = document.getElementById('stAdm').value;

        if (type === 'cita') {
            data.msg_date = document.getElementById('stCitaDate') ? document.getElementById('stCitaDate').value : '';
            data.msg_time = document.getElementById('stCitaTime') ? document.getElementById('stCitaTime').value : '';
            data.interval = document.getElementById('stCitaInterval') ? document.getElementById('stCitaInterval').value : '30';
        }

        if(stepsToCreate.length > 0) {
            stepsToCreate = [...new Set(stepsToCreate)];
            
            for (const newStepName of stepsToCreate) {
                if(!flow[newStepName]) {
                    console.log("✨ Creando paso automático:", newStepName);
                    const placeholderData = { type: 'message', message: '🚧 Paso creado automáticamente. Edítame.' };
                    await fetch('/api/flow/step', { 
                        method: 'POST', 
                        headers: {'Content-Type': 'application/json'}, 
                        body: JSON.stringify({ stepId: newStepName, stepData: placeholderData }) 
                    });
                    flow[newStepName] = placeholderData;
                }
            }
            showToast(`✨ ${stepsToCreate.length} pasos nuevos creados`);
        }

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

    // --- CARGAR RESPUESTAS RÁPIDAS ---
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

            const pendientes = rules.filter(r => !r.answer || r.answer.trim() === '');
            const activas = rules.filter(r => r.answer && r.answer.trim() !== '');
            let htmlBuffer = '';

            if (pendientes.length > 0) {
                htmlBuffer += `<h3 style="grid-column: 1/-1; color: var(--danger); margin-top: 10px;"><i class="fas fa-exclamation-circle"></i> Dudas por aprender (${pendientes.length})</h3>`;
                pendientes.forEach(r => {
                    htmlBuffer += `
                    <div style="background:rgba(239, 68, 68, 0.1); padding:15px; border-radius:10px; border:1px solid var(--danger); position:relative;">
                        <div style="margin-bottom:10px;"><span style="background:var(--danger); color:white; padding:2px 8px; border-radius:4px; font-size:0.8rem;">${r.keywords}</span></div>
                        <div style="color:var(--danger); font-size:0.85rem; margin-bottom:15px; font-style: italic;">Sin respuesta asignada.</div>
                        <div style="position:absolute; top:10px; right:10px; display:flex; gap:10px;">
                            <button onclick="openKeywordModal('${r.id}', '${r.keywords}', '${r.answer || ''}')" style="background:none; border:none; color:var(--primary); cursor:pointer;"><i class="fas fa-pen"></i></button>
                            <button onclick="deleteKeyword('${r.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer;"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                });
            }

            if (activas.length > 0) {
                htmlBuffer += `<h3 style="grid-column: 1/-1; color: var(--text-main); margin-top: 20px;"><i class="fas fa-check-circle" style="color:var(--success)"></i> Respuestas Activas</h3>`;
                activas.forEach(r => {
                    const tags = r.keywords.split(',').map(k => `<span style="background:rgba(59,130,246,0.2); color:#60a5fa; padding:2px 8px; border-radius:4px; font-size:0.8rem; margin-right:5px;">${k.trim()}</span>`).join('');
                    htmlBuffer += `
                    <div style="background:var(--bg-input); padding:15px; border-radius:10px; border:1px solid var(--border); position:relative;">
                        <div style="margin-bottom:10px;">${tags}</div>
                        <div style="color:var(--text-main); white-space:pre-wrap; font-size:0.9rem; margin-bottom:15px; padding:10px; background:rgba(0,0,0,0.2); border-radius:6px;">${r.answer}</div>
                        <div style="position:absolute; top:10px; right:10px; display:flex; gap:10px;">
                            <button onclick="openKeywordModal('${r.id}', '${r.keywords}', '${r.answer || ''}')" style="background:none; border:none; color:var(--primary); cursor:pointer;"><i class="fas fa-pen"></i></button>
                            <button onclick="deleteKeyword('${r.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer;"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                });
            }

            container.innerHTML = htmlBuffer;

        } catch (e) {
            console.error(e);
            container.innerHTML = 'Error cargando reglas.';
        }
    }

    function openKeywordModal(id = null, keywords = '', answer = '') {
        currentEditKwId = id;
        document.getElementById('kwInput').value = keywords;
        document.getElementById('kwAnswer').value = answer;
        document.getElementById('keywordModal').classList.add('active');
    }

    async function saveKeywordRule() {
        const keywords = document.getElementById('kwInput').value.trim();
        const answer = document.getElementById('kwAnswer').value.trim();

        if (!keywords || !answer) return alert("Escribe las palabras clave y la respuesta.");

        const payload = { keywords, answer };
        if (currentEditKwId) {
            payload.id = currentEditKwId;
        }

        try {
            await fetch('/api/keywords', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        
            document.getElementById('keywordModal').classList.remove('active');
            showToast("✅ Regla guardada");
            loadKeywords(); 
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
        let htmlBuffer = ''; 
        
        for(let i=0; i<firstDay; i++) htmlBuffer += `<div></div>`;

        for(let i=1; i<=daysInMonth; i++) {
            const k = `${y}-${(m+1).toString().padStart(2,'0')}-${i.toString().padStart(2,'0')}`;
            const count = (appts[k]||[]).length;
            const isToday = new Date().toDateString() === new Date(y,m,i).toDateString();
            htmlBuffer += `<div class="day ${isToday?'today':''}" onclick="openDayModal('${k}')">${i} ${count?`<span class="day-indicator">${count}</span>`:''}</div>`;
        }
        
        g.innerHTML = htmlBuffer; 
    }

    function changeMonth(d) { currentRefDate.setMonth(currentRefDate.getMonth()+d); renderCalendar(); }

    async function openDayModal(date) {
        document.getElementById('modalDateTitle').innerText = date;
        const list = document.getElementById('modalApptList');
        list.innerHTML = 'Cargando...';

        const all = await (await fetch(`${API_BASE}/api/agenda`)).json();
        const appts = all[date] || [];

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
            toggleSchedulerUI();

        } catch (e) {
            console.error("Error scheduler config", e);
        }
    }

    async function saveSchedulerConfig() {
        const active = document.getElementById('schActive').checked;
        const time = document.getElementById('schTime').value;
        const targetStep = document.getElementById('schStepSelect').value;

        if (active && (!time || !targetStep)) { return; }

        const payload = {
            scheduler: { active: active, time: time, target_step: targetStep, last_run: "" }
        };

        try {
            await fetch(`${API_BASE}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            showToast("💾 Configuración guardada");
        } catch (e) { showToast("Error al guardar"); }
    }

    let phoneToDelete = null;
    let isEditingMode = false;

    function editCurrentContactManual() {
        if (!currentChatPhone) return;
        const currentName = document.getElementById('waHeaderName').innerText;
        
        // Llenamos el input con el nombre actual
        document.getElementById('editNameInput').value = currentName;
        
        // Abrimos tu nuevo modal bonito
        document.getElementById('editNameModal').classList.add('active');
        
        // Enfocamos el input automáticamente
        setTimeout(() => document.getElementById('editNameInput').focus(), 100);
    }

    function closeEditNameModal() {
        document.getElementById('editNameModal').classList.remove('active');
    }

    async function confirmEditName() {
        if (!currentChatPhone) return;
        
        const newName = document.getElementById('editNameInput').value.trim();
        if (!newName) {
            showToast("⚠️ El nombre no puede estar vacío");
            return;
        }

        // Cerramos el modal mientras enviamos la petición
        closeEditNameModal();

        try {
            const response = await fetch(`${API_BASE}/api/contacts/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: currentChatPhone, 
                    name: newName,           
                    enable: document.getElementById('waBotSwitch').checked 
                })
            });

            const res = await response.json();

            if (res.success || response.ok) {
                document.getElementById('waHeaderName').innerText = newName;
                const u = users.find(x => getCleanPhone(x.phone) === getCleanPhone(currentChatPhone));
                if(u) {
                    u.savedName = newName; 
                    if(u.history) u.history.nombre = newName;
                }
                renderChatList(users);
                showToast("✅ Nombre actualizado");
            } else { 
                alert("Error al guardar en el servidor"); 
            }
        } catch (e) { 
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
        loadActivity(); 
    }

    function askDelete(phone, name) {
        phoneToDelete = phone;
        document.getElementById('delContactName').innerText = name || phone;
        document.getElementById('deleteConfirmModal').classList.add('active');
    }

    async function executeDelete() {
        if(!phoneToDelete) return;
        await fetch(`${API_BASE}/api/contacts/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone: phoneToDelete}) });
        allContactsCache = allContactsCache.filter(u => u.phone !== phoneToDelete);
        document.getElementById('deleteConfirmModal').classList.remove('active');
        loadActivity(); 
        showToast('Contacto eliminado');
    }

    function formatSmartDate(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return ''; 

        const now = new Date();
        const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffTime = today.getTime() - msgDate.getTime();
        const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

        if (diffDays === 0) { return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }); } 
        else if (diffDays === 1) { return 'Ayer'; } 
        else if (diffDays > 1 && diffDays < 7) {
            const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
            return dias[date.getDay()];
        } else { return date.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
    }

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

        if(v === 'activity') loadActivity();
        if(v === 'keywords') loadKeywords();
        if(v === 'agenda') {
            renderCalendar();       
            loadSchedulerConfig();  
        }

        const titles = { activity:'MONITOR', flow:'FLUJO', agenda:'AGENDA', settings:'AJUSTES', keywords: 'RESPUESTAS RÁPIDAS', config: 'CONFIGURACIÓN' };
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

        if (active && (!start || !end || !msg)) { return; }

        const s = { active: active, start: start, end: end, offline_message: msg };

        try {
            await fetch(`${API_BASE}/api/settings`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({schedule:s}) });
            showToast('💾 Horario guardado');
        } catch(e) { showToast('Error al guardar'); }
    }

    function showToast(m) { 
        const c = document.getElementById('toast-container'); 
        if(c) {
            c.innerHTML += `<div class="toast">${m}</div>`; 
            setTimeout(() => { if(c.lastChild) c.lastChild.remove(); }, 3000); 
        }
    }
    
    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
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

    async function saveTimezone() {
        const tz = document.getElementById('botTimezone').value;
        try {
            await fetch(`${API_BASE}/api/settings`, { 
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body:JSON.stringify({ timezone: tz }) 
            });
            showToast('✅ Zona horaria actualizada');
        } catch(e) { 
            showToast('❌ Error al guardar'); 
        }
    }

    let tzPreviewInterval = null;

    function previewTimezone() {
        const tz = document.getElementById('botTimezone').value;
        const previewEl = document.getElementById('tzPreview');
        if(!previewEl) return;

        if(tzPreviewInterval) clearInterval(tzPreviewInterval);

        const updateClock = () => {
            try {
                const now = new Date();
                const formatted = new Intl.DateTimeFormat('es-MX', {
                    timeZone: tz,
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true
                }).format(now);
                const finalStr = formatted.charAt(0).toUpperCase() + formatted.slice(1);
                previewEl.innerHTML = `<i class="far fa-clock"></i> ${finalStr}`;
            } catch(e) {
                previewEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Zona horaria no soportada';
            }
        };

        updateClock();
        tzPreviewInterval = setInterval(updateClock, 1000);
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

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
