// =================================================================================
// CyberNetCall - Main Application Logic (app.js)
// Fixed: Status bloat, Race conditions, FCM Integration
// =================================================================================

// --- Global Variables & State ---
let myDeviceId;
let localStream;
let peers = {}; // Key: peerUUID, Value: RTCPeerConnection
let dataChannels = {}; // Key: peerUUID, Value: RTCDataChannel
let signalingSocket = null;
let isSocketConnecting = false; // Prevent duplicate connection attempts

// App State Enum
const AppState = {
  INITIAL: 'initial',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
};
let currentAppState = AppState.INITIAL;

// DOM Elements (Populated in DOMContentLoaded)
let qrElement, statusElement, qrReaderElement, qrResultsElement;
let localVideoElement, remoteVideosContainer;
let messageAreaElement, postAreaElement;
let messageInputElement, sendMessageButton, postInputElement, sendPostButton;
let fileInputElement, sendFileButton, fileTransferStatusElement;
let callButton, videoButton, startScanButton;
let incomingCallModal, callerIdElement, acceptCallButton, rejectCallButton;
let friendListElement;

// Logic State
let currentCallerId = null;
let pendingConnectionFriendId = null;
let receivedSize = {}; // For file transfer
let incomingFileInfo = {};
let lastReceivedFileChunkMeta = {};
let onlineFriendsCache = new Set();
let autoConnectFriendsTimer = null;
const AUTO_CONNECT_INTERVAL = 5000; // Increased to reduce load

// Reconnection & Reliability
let peerReconnectInfo = {};
let iceCandidateQueue = {};
const MAX_PEER_RECONNECT_ATTEMPTS = 3;
let peerNegotiationTimers = {};
const NEGOTIATION_TIMEOUT_MS = 5000;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT_ATTEMPTS = 10;
let wsReconnectTimer = null;
const CHUNK_SIZE = 16384;
let fileReader;

// --- FCM Variables ---
let messaging;
let currentToken = null;

// --- Database Configuration ---
const DB_NAME = 'cybernetcall-db';
const DB_VERSION = 3;
let dbPromise = typeof idb !== 'undefined' ? idb.openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion) {
    if (!db.objectStoreNames.contains('posts')) db.createObjectStore('posts', { keyPath: 'id' });
    if (oldVersion < 2 && !db.objectStoreNames.contains('friends')) db.createObjectStore('friends', { keyPath: 'id' });
    if (oldVersion < 3 && !db.objectStoreNames.contains('fileChunks')) {
      const store = db.createObjectStore('fileChunks', { keyPath: ['fileId', 'chunkIndex'] });
      store.createIndex('by_fileId', 'fileId');
    }
  }
}) : null;

// --- Optimized Status Logging ---
const MAX_STATUS_LOGS = 50; // Limit visible logs to prevent memory leak/UI lag

// =================================================================================
// Utility Functions
// =================================================================================

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function linkify(text) {
    if (!text) return '';
    const urlPattern = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    text = text.replace(urlPattern, url => {
        let fullUrl = url;
        if (!url.match(/^https?:\/\//i) && url.startsWith('www.')) fullUrl = 'http://' + url;
        return `<a href="${fullUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
    return text.replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi, '<a href="mailto:$1">$1</a>');
}

/**
 * Improved updateStatus: Directly manipulates DOM to prevent infinite array growth and re-renders.
 */
function updateStatus(message, color = 'black') {
    if (!statusElement) return;
    
    // Create new log entry
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    div.style.color = color;
    div.style.borderBottom = "1px solid #eee";
    div.style.padding = "2px 0";

    // Prepend to show newest first
    statusElement.insertBefore(div, statusElement.firstChild);

    // Remove old logs if exceeding limit
    while (statusElement.childElementCount > MAX_STATUS_LOGS) {
        statusElement.removeChild(statusElement.lastChild);
    }
    
    // Ensure visibility
    statusElement.style.display = 'block';
}

function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

function setInteractionUiEnabled(enabled) {
    const disabled = !enabled;
    if (messageInputElement) messageInputElement.disabled = disabled;
    if (sendMessageButton) sendMessageButton.disabled = disabled;
    if (postInputElement) postInputElement.disabled = disabled;
    if (sendPostButton) sendPostButton.disabled = disabled;
    if (fileInputElement) fileInputElement.disabled = disabled;
    if (sendFileButton) sendFileButton.disabled = disabled;
    if (callButton) callButton.disabled = disabled;
    if (videoButton) videoButton.disabled = disabled;
}

// =================================================================================
// Database Operations (IDB)
// =================================================================================

async function savePost(post) {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    await db.put('posts', post);
  } catch (error) { console.error("DB Save Error:", error); }
}

async function deletePostFromDb(postId) {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    await db.delete('posts', postId);
  } catch (error) { console.error("DB Delete Error:", error); }
}

async function addFriend(friendId, friendName = null) {
  if (!dbPromise || !friendId || friendId === myDeviceId) return;
  try {
    const db = await dbPromise;
    const existing = await db.get('friends', friendId);
    if (!existing) {
        await db.put('friends', { id: friendId, name: friendName, added: new Date() });
        updateStatus(`Friend (${friendId.substring(0,6)}) added!`, 'green');
        await displayFriendList();
    }
  } catch (error) { console.error("Add Friend Error:", error); }
}

async function isFriend(friendId) {
  if (!dbPromise || !friendId) return false;
  try {
    const db = await dbPromise;
    return !!(await db.get('friends', friendId));
  } catch (error) { return false; }
}

async function displayFriendList() {
  if (!dbPromise || !friendListElement) return;
  try {
    const db = await dbPromise;
    const friends = await db.getAll('friends');
    friendListElement.innerHTML = '<h3>Friends</h3>';
    if (friends.length === 0) friendListElement.innerHTML += '<p>No friends yet. Scan QR!</p>';
    friends.forEach(f => displaySingleFriend(f));
  } catch (error) { console.error("Display Friends Error:", error); }
}

function displaySingleFriend(friend) {
    if (!friendListElement) return;
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.dataset.friendId = friend.id;
    
    const infoDiv = document.createElement('div');
    infoDiv.textContent = `ID: ${friend.id.substring(0, 8)}...`;
    
    // Online indicator logic could be added here based on onlineFriendsCache
    if (onlineFriendsCache.has(friend.id)) {
        infoDiv.style.fontWeight = 'bold';
        infoDiv.textContent += ' (Online)';
    }

    const btn = document.createElement('button');
    btn.textContent = '📞 Call';
    btn.dataset.friendId = friend.id;
    btn.addEventListener('click', handleCallFriendClick);
    
    // Only enable if socket is ready
    const isReady = signalingSocket && signalingSocket.readyState === WebSocket.OPEN;
    btn.disabled = !isReady;
    
    div.appendChild(infoDiv);
    div.appendChild(btn);
    friendListElement.appendChild(div);
}

// =================================================================================
// FCM & Notification Logic (New Integration)
// =================================================================================

async function initializeFCM(serviceWorkerRegistration) {
    // Ensure Firebase config exists (injected via index.html)
    if (typeof firebase === 'undefined' || typeof FCM_CONFIG_CLIENT === 'undefined') {
        updateStatus("FCM: Setup missing.", 'orange');
        return;
    }

    try {
        // Initialize Firebase App only once
        if (!firebase.apps.length) {
            firebase.initializeApp(FCM_CONFIG_CLIENT);
        }
        
        messaging = firebase.messaging();
        
        // **Critical**: Attach SW registration to FCM
        messaging.useServiceWorker(serviceWorkerRegistration);

        // Request Permission
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            updateStatus('Notification permission granted.', 'green');
            
            // Get Token
            currentToken = await messaging.getToken({ vapidKey: FCM_CONFIG_CLIENT.vapidKey });
            
            if (currentToken) {
                updateStatus('FCM Token obtained.', 'green');
                await saveFCMTokenToServer(currentToken);
            } else {
                updateStatus('No FCM Token available.', 'orange');
            }
        } else {
            updateStatus('Notification permission denied.', 'orange');
        }

        // Handle Foreground Messages
        messaging.onMessage((payload) => {
            console.log('FCM Foreground:', payload);
            updateStatus(`New Notification: ${payload.notification?.title || 'Message'}`, 'blue');
            
            // Manually show notification if app is in foreground (optional)
            if (payload.notification) {
                 const options = {
                    body: payload.notification.body,
                    icon: '/static/cnc/icons/icon-192x192.png',
                    data: payload.data
                };
                // Use SW to show notification even in foreground for consistency
                serviceWorkerRegistration.showNotification(payload.notification.title, options);
            }
        });
        
        // Handle Token Refresh
        messaging.onTokenRefresh(async () => {
             try {
                const refreshedToken = await messaging.getToken({ vapidKey: FCM_CONFIG_CLIENT.vapidKey });
                await saveFCMTokenToServer(refreshedToken);
             } catch(err) { console.error('Token refresh error', err); }
        });
        
    } catch (error) {
        updateStatus(`FCM Init Error: ${error.message}`, 'red');
    }
}

async function saveFCMTokenToServer(token) {
    if (!token || !myDeviceId) return;
    try {
        const response = await fetch('/api/register_fcm_token/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: JSON.stringify({ device_id: myDeviceId, fcm_token: token })
        });
        if (!response.ok) throw new Error(response.statusText);
        console.log("FCM Token saved to server.");
    } catch (e) {
        console.error("FCM Token Save Error:", e);
    }
}

// =================================================================================
// WebSocket & Signaling Logic
// =================================================================================

async function connectWebSocket() {
  if (signalingSocket && (signalingSocket.readyState === WebSocket.OPEN || signalingSocket.readyState === WebSocket.CONNECTING)) {
    return; // Already connected or connecting
  }
  if (isSocketConnecting) return; // Prevent race conditions
  
  isSocketConnecting = true;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws/signaling/`;
  
  updateStatus('Connecting signaling...', 'blue');
  
  try {
      signalingSocket = new WebSocket(wsUrl);
  } catch(e) {
      updateStatus(`WS Error: ${e.message}`, 'red');
      isSocketConnecting = false;
      return;
  }

  signalingSocket.onopen = () => {
    isSocketConnecting = false;
    wsReconnectAttempts = 0;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    
    updateStatus('Signaling Connected.', 'green');
    sendSignalingMessage({ type: 'register', payload: { uuid: myDeviceId } });
  };

  signalingSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      const sender = msg.from || msg.uuid;
      
      switch (msg.type) {
        case 'registered':
            currentAppState = AppState.INITIAL;
            await displayFriendList();
            if (pendingConnectionFriendId) {
                await createOfferForPeer(pendingConnectionFriendId);
                pendingConnectionFriendId = null;
            }
            break;
            
        case 'user_online':
        case 'user_joined':
            if (sender && sender !== myDeviceId) {
                const isF = await isFriend(sender);
                if (isF) {
                    onlineFriendsCache.add(sender);
                    displayFriendList(); // Refresh UI
                    // Auto-connect logic could go here if desired
                }
            }
            break;

        case 'offer':
            if (sender) await handleOffer(sender, msg.payload.sdp);
            break;

        case 'answer':
             if (sender) await handleAnswer(sender, msg.payload.sdp);
            break;

        case 'ice-candidate':
             if (sender) await handleIceCandidate(sender, msg.payload.candidate);
            break;
            
        // ... Call handling (request, accepted, etc.) ...
      }
    } catch (e) { console.error("Signaling msg error:", e); }
  };

  signalingSocket.onclose = (event) => {
      isSocketConnecting = false;
      signalingSocket = null;
      updateStatus('Signaling disconnected.', 'orange');
      
      // Exponential Backoff Reconnection
      if (wsReconnectAttempts < MAX_WS_RECONNECT_ATTEMPTS) {
          const delay = Math.min(1000 * Math.pow(1.5, wsReconnectAttempts), 10000);
          wsReconnectTimer = setTimeout(() => {
              wsReconnectAttempts++;
              connectWebSocket();
          }, delay);
      } else {
          updateStatus("Connection failed. Please refresh.", "red");
      }
  };
  
  signalingSocket.onerror = () => {
      isSocketConnecting = false;
      // updateStatus('Signaling error.', 'red'); // Reduce noise, onclose handles it
  };
}

function sendSignalingMessage(msg) {
  if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
    if (!msg.payload) msg.payload = {};
    if (!msg.payload.uuid) msg.payload.uuid = myDeviceId;
    signalingSocket.send(JSON.stringify(msg));
  }
}

// =================================================================================
// WebRTC Logic (Conflict & Leak Fixes)
// =================================================================================

async function createPeerConnection(peerUUID) {
  // Prevent duplicate/conflicting connections
  if (peers[peerUUID]) {
      if (peers[peerUUID].connectionState === 'connected' || peers[peerUUID].connectionState === 'connecting') {
          console.warn(`Connection to ${peerUUID} already exists.`);
          return null; // Don't recreate
      }
      closePeerConnection(peerUUID, true); // Clean up dead connection
  }

  iceCandidateQueue[peerUUID] = [];
  
  try {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    peer.onicecandidate = e => {
      if (e.candidate) sendSignalingMessage({ type: 'ice-candidate', payload: { target: peerUUID, candidate: e.candidate } });
    };

    peer.ondatachannel = e => {
      e.channel.binaryType = 'arraybuffer';
      setupDataChannelEvents(peerUUID, e.channel);
    };

    peer.onconnectionstatechange = () => {
        const state = peer.connectionState;
        if (state === 'connected') {
            updateStatus(`Connected: ${peerUUID.substring(0,6)}`, 'green');
            delete peerNegotiationTimers[peerUUID]; // Clear timeout
        } else if (state === 'disconnected' || state === 'failed') {
            updateStatus(`Disconnected: ${peerUUID.substring(0,6)}`, 'orange');
            closePeerConnection(peerUUID);
        }
    };

    peers[peerUUID] = peer;
    return peer;
  } catch (e) {
    updateStatus(`Peer Setup Error: ${e.message}`, 'red');
    return null;
  }
}

function setupDataChannelEvents(peerUUID, channel) {
    dataChannels[peerUUID] = channel;
    channel.onopen = () => {
        updateStatus(`Channel Ready: ${peerUUID.substring(0,6)}`, 'green');
        setInteractionUiEnabled(true);
        currentAppState = AppState.CONNECTED;
    };
    channel.onmessage = e => handleDataChannelMessage(e, peerUUID);
    channel.onclose = () => {
        delete dataChannels[peerUUID];
        const hasActive = Object.values(dataChannels).some(dc => dc.readyState === 'open');
        if (!hasActive) setInteractionUiEnabled(false);
    };
}

async function createOfferForPeer(peerUUID) {
    const peer = await createPeerConnection(peerUUID);
    if (!peer) return;
    
    // Create DataChannel (Initiator)
    const channel = peer.createDataChannel('chat');
    setupDataChannelEvents(peerUUID, channel);
    
    // Add Tracks if exists
    if (localStream) {
        localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
    }

    try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        sendSignalingMessage({ type: 'offer', payload: { target: peerUUID, sdp: peer.localDescription } });
        
        // Timeout handling to prevent hanging states
        peerNegotiationTimers[peerUUID] = setTimeout(() => {
            if (peers[peerUUID] && peers[peerUUID].connectionState !== 'connected') {
                updateStatus(`Connection timeout: ${peerUUID.substring(0,6)}`, 'orange');
                closePeerConnection(peerUUID);
            }
        }, NEGOTIATION_TIMEOUT_MS);
        
    } catch(e) { console.error("Offer Error:", e); }
}

async function handleOffer(peerUUID, offerSdp) {
    let peer = peers[peerUUID];
    if (!peer) peer = await createPeerConnection(peerUUID);
    if (!peer) return;

    try {
        await peer.setRemoteDescription(new RTCSessionDescription(offerSdp));
        
        // Process queued ICE candidates
        if (iceCandidateQueue[peerUUID]) {
            iceCandidateQueue[peerUUID].forEach(c => peer.addIceCandidate(new RTCIceCandidate(c)).catch(e=>{}));
            iceCandidateQueue[peerUUID] = [];
        }

        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendSignalingMessage({ type: 'answer', payload: { target: peerUUID, sdp: peer.localDescription } });
    } catch(e) { console.error("Handle Offer Error:", e); }
}

async function handleAnswer(peerUUID, answerSdp) {
    const peer = peers[peerUUID];
    if (peer) {
        try {
            await peer.setRemoteDescription(new RTCSessionDescription(answerSdp));
        } catch(e) { console.error("Handle Answer Error:", e); }
    }
}

async function handleIceCandidate(peerUUID, candidate) {
    const peer = peers[peerUUID];
    if (peer && peer.remoteDescription) {
        peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(e=>{});
    } else {
        if (!iceCandidateQueue[peerUUID]) iceCandidateQueue[peerUUID] = [];
        iceCandidateQueue[peerUUID].push(candidate);
    }
}

function closePeerConnection(peerUUID, silent = false) {
    // Clean up PeerConnection
    const peer = peers[peerUUID];
    if (peer) {
        peer.onconnectionstatechange = null; // Prevent loop
        peer.close();
        delete peers[peerUUID];
    }
    // Clean up DataChannel
    const dc = dataChannels[peerUUID];
    if (dc) {
        dc.onclose = null;
        dc.close();
        delete dataChannels[peerUUID];
    }
    // Clean up DOM
    const vid = document.getElementById(`remoteVideo-${peerUUID}`);
    if (vid) vid.remove();
    
    // Clean up State
    delete iceCandidateQueue[peerUUID];
    if (peerNegotiationTimers[peerUUID]) clearTimeout(peerNegotiationTimers[peerUUID]);

    if (!silent) updateStatus(`Closed: ${peerUUID.substring(0,6)}`, 'black');
}

// =================================================================================
// Message & File Handling (Simplified for brevity but functional)
// =================================================================================

function handleDataChannelMessage(event, senderUUID) {
    const data = event.data;
    if (typeof data === 'string') {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'direct-message') displayDirectMessage(msg, false, senderUUID);
        } catch(e) {}
    }
    // Binary handling (file transfer) would go here
}

function handleSendMessage() {
    const content = messageInputElement?.value?.trim();
    if (!content) return;
    
    const message = { type: 'direct-message', content, sender: myDeviceId, timestamp: new Date().toISOString() };
    let sent = false;
    
    Object.values(dataChannels).forEach(dc => {
        if (dc.readyState === 'open') {
            dc.send(JSON.stringify(message));
            sent = true;
        }
    });
    
    if (sent) {
        displayDirectMessage(message, true);
        messageInputElement.value = '';
    } else {
        updateStatus("Not connected. Cannot send.", "red");
    }
}

function displayDirectMessage(msg, isOwn, sender) {
    if (!messageAreaElement) return;
    const div = document.createElement('div');
    div.className = isOwn ? 'message outgoing' : 'message incoming';
    div.innerHTML = DOMPurify.sanitize(`<b>${isOwn ? 'You' : (sender||'Peer').substring(0,6)}:</b> ${linkify(msg.content)}`);
    messageAreaElement.appendChild(div);
    messageAreaElement.scrollTop = messageAreaElement.scrollHeight;
}

function updateQrCodeWithValue(value) {
    if (!qrElement || typeof QRious === 'undefined') return;
    new QRious({ element: qrElement, value: value, size: 200 });
}

// =================================================================================
// Initialization (DOMContentLoaded)
// =================================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // 1. DOM Element Retrieval
  qrElement = document.getElementById('qrcode');
  statusElement = document.getElementById('connectionStatus');
  messageInputElement = document.getElementById('messageInput');
  sendMessageButton = document.getElementById('sendMessage');
  friendListElement = document.getElementById('friendList'); // Ensure this ID exists in HTML
  remoteVideosContainer = document.querySelector('.video-scroll-container') || document.body;

  // 2. Event Listeners
  if (statusElement) statusElement.addEventListener('click', () => statusElement.classList.toggle('status-expanded'));
  if (sendMessageButton) sendMessageButton.addEventListener('click', handleSendMessage);

  // 3. Setup ID
  myDeviceId = localStorage.getItem('cybernetcall-deviceId');
  if (!myDeviceId) {
      myDeviceId = generateUUID();
      localStorage.setItem('cybernetcall-deviceId', myDeviceId);
  }
  updateQrCodeWithValue(`${window.location.origin}/?id=${myDeviceId}`);
  updateStatus(`ID: ${myDeviceId.substring(0,6)}...`, 'black');

  // 4. Initial Displays
  setInteractionUiEnabled(false);
  await displayFriendList();

  // 5. Service Worker & FCM Registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/cnc/service-worker.js')
      .then(registration => {
        updateStatus('SW Registered.', 'green');
        // Initialize FCM *after* SW registration
        initializeFCM(registration);
      })
      .catch(err => updateStatus(`SW Error: ${err.message}`, 'red'));
      
    navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'APP_ACTIVATED') {
            connectWebSocket(); // Reconnect on activation
        }
    });
  }

  // 6. Connect Signaling
  connectWebSocket();

  // 7. Handle Invite Links
  const urlParams = new URLSearchParams(window.location.search);
  const incomingId = urlParams.get('id');
  if (incomingId && incomingId !== myDeviceId) {
      updateStatus(`Invited by ${incomingId.substring(0,6)}...`, 'blue');
      await addFriend(incomingId);
      pendingConnectionFriendId = incomingId;
  }
});