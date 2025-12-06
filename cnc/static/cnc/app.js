// Original variables [cite: 1783]
let myDeviceId;
let localStream;
let peers = {};
let dataChannels = {};
let signalingSocket = null;

// --- FCM Variables ---
let firebaseApp;
let messaging;
// FCM_CONFIG_CLIENT は index.html で定義されていることを前提とする
// ---------------------

// Original AppState [cite: 1784]
const AppState = {
  INITIAL: 'initial',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
};
let currentAppState = AppState.INITIAL;

// Original DOM elements [cite: 1785, 1786]
let qrElement, statusElement, qrReaderElement, qrResultsElement, localVideoElement, remoteVideoElement, messageAreaElement, postAreaElement;
let messageInputElement, sendMessageButton, postInputElement, sendPostButton;
let fileInputElement, sendFileButton, fileTransferStatusElement;
let callButton, videoButton;
let startScanButton;
let remoteVideosContainer;
let incomingCallModal, callerIdElement, acceptCallButton, rejectCallButton;
let currentCallerId = null;
let friendListElement;

// Original state variables [cite: 1787, 1788, 1789, 1790, 1791]
let pendingConnectionFriendId = null;
let receivedSize = {};
let incomingFileInfo = {};
let lastReceivedFileChunkMeta = {};
let onlineFriendsCache = new Set();
let autoConnectFriendsTimer = null;
const AUTO_CONNECT_INTERVAL = 2000;
let peerReconnectInfo = {};
let iceCandidateQueue = {};
const MAX_PEER_RECONNECT_ATTEMPTS = 3;
const INITIAL_PEER_RECONNECT_DELAY_MS = 2000;
let peerNegotiationTimers = {};
const NEGOTIATION_TIMEOUT_MS = 3000;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT_ATTEMPTS = 10;
const INITIAL_WS_RECONNECT_DELAY_MS = 2000;
const MAX_WS_RECONNECT_DELAY_MS = 5000;
let wsReconnectTimer = null;
let isAttemptingReconnect = false;
const CHUNK_SIZE = 16384;
let fileReader;
const DB_NAME = 'cybernetcall-db';
const DB_VERSION = 3;

// Original IDB initialization [cite: 1792, 1793]
let dbPromise = typeof idb !== 'undefined' ? idb.openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion) {
    if (!db.objectStoreNames.contains('posts')) {
      db.createObjectStore('posts', { keyPath: 'id' });
    }
    if (oldVersion < 2 && !db.objectStoreNames.contains('friends')) {
      db.createObjectStore('friends', { keyPath: 'id' });
    }
    if (oldVersion < 3 && !db.objectStoreNames.contains('fileChunks')) {
      const store = db.createObjectStore('fileChunks', { keyPath: ['fileId', 'chunkIndex'] });
      store.createIndex('by_fileId', 'fileId');
    }
  }
}) : null;
if (!dbPromise) {
}
let statusMessages = [];
const MAX_STATUS_MESSAGES = 1000;

// --- FCM/CSRF Utility Functions ---

/**
 * Retrieves the CSRF token from cookies for Django POST requests.
 * @param {string} name The name of the cookie (e.g., 'csrftoken').
 * @returns {string|null} The cookie value or null.
 */
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

/**
 * Initializes Firebase and sets up the Messaging service.
 */
function initFCM() {
    // FCM_CONFIG_CLIENTはindex.htmlで定義されていることを前提
    if (typeof firebase === 'undefined' || typeof FCM_CONFIG_CLIENT === 'undefined' || !FCM_CONFIG_CLIENT.apiKey) {
        updateStatus("FCM: Firebase SDK or configuration not available. Notifications disabled.", 'orange');
        return;
    }
    try {
        // Appの初期化は一度だけ行う
        if (!firebase.apps.length) {
            firebaseApp = firebase.initializeApp(FCM_CONFIG_CLIENT);
            messaging = firebase.messaging();
            updateStatus("FCM: Firebase initialized.", 'blue');

            // フォアグラウンドメッセージのハンドリング
            messaging.onMessage((payload) => {
                console.log('FCM Foreground message received. ', payload);
                updateStatus(`FCM: New Notification - ${payload.notification?.title} (${payload.data?.type})`, 'blue');
                // PWAの通知として表示（PayloadをService Workerに渡す）
                navigator.serviceWorker.ready.then(registration => {
                    if (payload.notification) {
                         registration.showNotification(payload.notification.title || 'New Message', {
                            body: payload.notification.body,
                            icon: payload.notification.icon || '/static/cnc/icons/icon-192x192.png',
                            data: payload.data
                        });
                    }
                });
            });
        }
    } catch (e) {
        updateStatus(`FCM initialization error: ${e.message}`, 'red');
    }
}

/**
 * Sends the FCM token and myDeviceId to the Django server for storage.
 * @param {string} token The FCM registration token.
 */
async function saveFCMTokenToServer(token) {
    if (!token || !myDeviceId) {
        return;
    }
    updateStatus('FCM: Sending token to server...', 'blue');
    try {
        const csrfToken = getCookie('csrftoken');
        const response = await fetch('/api/save_fcm_token/', { // 仮定されるDjangoのエンドポイント
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken // DjangoのCSRF保護に対応
            },
            body: JSON.stringify({
                user_id: myDeviceId,
                fcm_token: token,
            })
        });

        if (response.ok) {
            updateStatus('FCM: Token saved successfully on server.', 'green');
        } else {
            updateStatus(`FCM: Failed to save token on server. Status: ${response.status}`, 'red');
        }
    } catch (error) {
        updateStatus(`FCM: Network error saving token: ${error.message}`, 'red');
    }
}

/**
 * Requests notification permission, retrieves the FCM token, and saves it to the server.
 */
async function requestFCMToken() {
    if (typeof messaging === 'undefined') {
        return;
    }
    updateStatus('FCM: Requesting notification permission...', 'blue');
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            updateStatus('FCM: Notification permission granted. Getting token...', 'blue');
            // VAPIDキーはFCM_CONFIG_CLIENTに含まれていることを想定
            const currentToken = await messaging.getToken({ vapidKey: FCM_CONFIG_CLIENT.vapidKey });
            if (currentToken) {
                updateStatus('FCM: Token retrieved successfully.', 'green');
                await saveFCMTokenToServer(currentToken);
            } else {
                updateStatus('FCM: No registration token available. Request permission again.', 'orange');
            }
        } else {
            updateStatus('FCM: Notification permission denied.', 'orange');
        }

        // トークンが更新された場合のハンドリング
        messaging.onTokenRefresh(async () => {
            updateStatus('FCM: Token refreshing...', 'blue');
            try {
                const refreshedToken = await messaging.getToken({ vapidKey: FCM_CONFIG_CLIENT.vapidKey });
                await saveFCMTokenToServer(refreshedToken);
            } catch (error) {
                updateStatus(`FCM: Error refreshing token: ${error.message}`, 'red');
            }
        });

    } catch (error) {
        updateStatus(`FCM: Error getting token: ${error.message}`, 'red');
    }
}

// ---------------------

// Original utility functions (Partial content, full code follows structure)

function generateUUID() { [cite: 1794]
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function linkify(text) { [cite: 1795]
    if (!text) return '';

    const urlPattern = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig; [cite: 1795]
    text = text.replace(urlPattern, function(url) { [cite: 1796]
        let fullUrl = url;
        if (!url.match(/^https?:\/\//i) && url.startsWith('www.')) {
            fullUrl = 'http://' + url;
        }
        return `<a href="${fullUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`; [cite: 1796]
    });
    const emailPattern = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi; [cite: 1797]
    text = text.replace(emailPattern, function(email) {
        return `<a href="mailto:${email}">${email}</a>`; [cite: 1797]
    });
    return text; [cite: 1798]
}

function renderStatusMessages() { [cite: 1798]
    if (!statusElement) return;
    statusElement.innerHTML = ''; [cite: 1799]
    // statusMessages は unshift で追加しているので、そのままの順で表示すると新しいものが上に来る
    statusMessages.forEach(msgObj => { [cite: 1799]
        const div = document.createElement('div');
        div.textContent = msgObj.text;
        div.style.color = msgObj.color;
        statusElement.appendChild(div);
    });
    statusElement.style.display = statusMessages.length > 0 ? 'block' : 'none'; [cite: 1800]
    // 必要であれば、常に一番下にスクロールする (新しいメッセージが下に追加される場合)
    // statusElement.scrollTop = statusElement.scrollHeight; [cite: 1800]
}

function updateStatus(message, color = 'black') { [cite: 1801]
    if (!statusElement) return;

    const messageText = String(message || ''); [cite: 1801, 1802]
    // 明示的に空のメッセージが指定された場合は、全てのステータスをクリアする
    if (messageText === '') { [cite: 1802]
        statusMessages = [];
        renderStatusMessages(); [cite: 1803]
        return;
    }
    const newMessage = {
        id: generateUUID(), // メッセージごとのユニークID [cite: 1803]
        text: messageText,
        color: color,
        timestamp: new Date() // タイムスタンプを追加
    };
    statusMessages.unshift(newMessage); // 新しいメッセージを配列の先頭に追加 [cite: 1804]

    if (statusMessages.length > MAX_STATUS_MESSAGES) {
        statusMessages.length = MAX_STATUS_MESSAGES; [cite: 1804, 1805]
    // 配列の末尾 (古いメッセージ) から削除
    }
    renderStatusMessages(); [cite: 1805]
}


function setInteractionUiEnabled(enabled) { [cite: 1806]
    const disabled = !enabled;
    if (messageInputElement) messageInputElement.disabled = disabled; [cite: 1806]
    if (sendMessageButton) sendMessageButton.disabled = disabled;
    if (postInputElement) postInputElement.disabled = disabled; [cite: 1807]
    if (sendPostButton) sendPostButton.disabled = disabled;
    if (fileInputElement) fileInputElement.disabled = disabled;
    if (sendFileButton) sendFileButton.disabled = disabled; [cite: 1807]
    if (callButton) callButton.disabled = disabled; [cite: 1808]
    if (videoButton) videoButton.disabled = disabled;

}
async function savePost(post) { [cite: 1808]
  if (!dbPromise) return;
  try { [cite: 1809]
    const db = await dbPromise;
    const tx = db.transaction('posts', 'readwrite');
    await tx.store.put(post);
    await tx.done; [cite: 1809]
  } catch (error) { [cite: 1810]
  }
}
async function deletePostFromDb(postId) { [cite: 1810]
  if (!dbPromise) return;
  try { [cite: 1811]
    const db = await dbPromise;
    const tx = db.transaction('posts', 'readwrite');
    await tx.store.delete(postId); [cite: 1811]
    await tx.done;
  } catch (error) { [cite: 1812]
  }
}
async function addFriend(friendId, friendName = null) { [cite: 1812]
  if (!dbPromise || !friendId) return;
  if (friendId === myDeviceId) { [cite: 1813]
      alert("You cannot add yourself as a friend.");
      return; [cite: 1814]
  }
  try {
    const db = await dbPromise; [cite: 1814]
    const tx = db.transaction('friends', 'readwrite'); [cite: 1815]
    const existing = await tx.store.get(friendId);
    if (existing) { [cite: 1815]
        updateStatus(`Friend (${friendId.substring(0,6)}) is already added.`, 'orange'); [cite: 1815, 1816]
        return;
    }
    await tx.store.put({ id: friendId, name: friendName, added: new Date() }); [cite: 1816]
    await tx.done;
    updateStatus(`Friend (${friendId.substring(0,6)}) added successfully!`, 'green'); [cite: 1817]
    await displayFriendList();
  } catch (error) {
    updateStatus("Failed to add friend.", 'red'); [cite: 1817, 1818]
  }
}
async function isFriend(friendId, dbInstance = null) { [cite: 1818]
  if (!dbPromise || !friendId) return false;
  try { [cite: 1819]
    const db = dbInstance || await dbPromise;
    const friend = await db.get('friends', friendId); [cite: 1819]
    return !!friend;
  } catch (error) { [cite: 1820]
    return false;
  }
}
async function displayFriendList() { [cite: 1820]
  if (!dbPromise || !friendListElement) return;
  try { [cite: 1821]
    const db = await dbPromise;
    const friends = await db.getAll('friends');
    friendListElement.innerHTML = '<h3>Friends</h3>'; [cite: 1821, 1822]
    if (friends.length === 0) {
        friendListElement.innerHTML += '<p>No friends added yet. [cite: 1822] Scan their QR code!</p>'; [cite: 1823]
    }
    friends.forEach(friend => displaySingleFriend(friend)); [cite: 1823, 1824]
  } catch (error) { [cite: 1824]
  }
}
async function displayInitialPosts() { [cite: 1824]
  if (!dbPromise || !postAreaElement) return;
  try { [cite: 1825]
    const db = await dbPromise;
    const posts = await db.getAll('posts');
    postAreaElement.innerHTML = ''; [cite: 1825, 1826]
    posts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    posts.forEach(post => displayPost(post, false)); [cite: 1826, 1827]
  } catch (error) { [cite: 1827]
  }
}
function displayPost(post, isNew = true) { [cite: 1827]
  if (!postAreaElement) return;
  const div = document.createElement('div'); [cite: 1828]
  div.className = 'post';
  div.id = `post-${post.id}`;
  const contentSpan = document.createElement('span');
  const linkedContent = linkify(post.content); [cite: 1828, 1829]
  contentSpan.innerHTML = DOMPurify.sanitize(`<strong>${post.sender ? post.sender.substring(0, 6) : 'Unknown'}:</strong> ${linkedContent}`); [cite: 1829]
  const deleteButton = document.createElement('button');
  deleteButton.textContent = '❌';
  deleteButton.className = 'delete-post-button'; [cite: 1829, 1830]
  deleteButton.dataset.postId = post.id;
  deleteButton.style.marginLeft = '10px';
  deleteButton.style.cursor = 'pointer';
  deleteButton.style.border = 'none';
  deleteButton.style.background = 'none';
  deleteButton.ariaLabel = 'Delete post'; [cite: 1830, 1831]
  deleteButton.addEventListener('click', handleDeletePost);
  div.appendChild(contentSpan);
  div.appendChild(deleteButton);
  if (isNew && postAreaElement.firstChild) { [cite: 1831]
      postAreaElement.insertBefore(div, postAreaElement.firstChild);
  } else { [cite: 1832]
      postAreaElement.appendChild(div);
  }
}
async function handleDeletePost(event) { [cite: 1832]
    const button = event.currentTarget;
    const postId = button.dataset.postId; [cite: 1833]
    if (!postId) return;
    const postElement = document.getElementById(`post-${postId}`); [cite: 1833, 1834]
    if (postElement) {
        postElement.remove(); [cite: 1834]
    }
    await deletePostFromDb(postId); [cite: 1834]
    const postDeleteMessage = JSON.stringify({ [cite: 1835]
        type: 'delete-post',
        postId: postId
    });
    broadcastMessage(postDeleteMessage); [cite: 1836]
}
function displaySingleFriend(friend) { [cite: 1836]
    if (!friendListElement) return;
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.dataset.friendId = friend.id; [cite: 1836, 1837]
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `ID: ${friend.id.substring(0, 8)}...`;
    const callFriendButton = document.createElement('button'); [cite: 1837]
    callFriendButton.textContent = '📞 Call';
    callFriendButton.dataset.friendId = friend.id;
    callFriendButton.addEventListener('click', handleCallFriendClick); [cite: 1838]
    callFriendButton.disabled = !signalingSocket || signalingSocket.readyState !== WebSocket.OPEN || currentAppState === AppState.CONNECTING || currentAppState === AppState.CONNECTED;
    div.appendChild(nameSpan);
    div.appendChild(callFriendButton);
    friendListElement.appendChild(div); [cite: 1839]
}
async function connectWebSocket() { [cite: 1839]
  if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
    return; [cite: 1840]
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; [cite: 1840]
  const wsUrl = `${wsProtocol}//${location.host}/ws/signaling/`;
  updateStatus('Connecting to signaling server...', 'blue'); [cite: 1841]
  signalingSocket = new WebSocket(wsUrl);
  signalingSocket.onopen = () => { [cite: 1841]
    wsReconnectAttempts = 0; [cite: 1842]
    isAttemptingReconnect = false;
    if (wsReconnectTimer) { [cite: 1842]
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null; [cite: 1843]
    }
    updateStatus('Connected to signaling server. Registering...', 'blue'); [cite: 1843, 1844]
    sendSignalingMessage({
      type: 'register',
      payload: { uuid: myDeviceId } [cite: 1844]
    });
  }; [cite: 1845]
  signalingSocket.onmessage = async (event) => { [cite: 1845]
    try {
      const message = JSON.parse(event.data); [cite: 1845, 1846]
      const messageType = message.type;
      const payload = message.payload || {};
      const senderUUID = message.from || message.uuid || payload.uuid; [cite: 1846, 1847]
      switch (messageType) { [cite: 1847]
        case 'registered':
            updateStatus('Connected to signaling server. Ready.', 'green'); [cite: 1847]
            currentAppState = AppState.INITIAL; [cite: 1848]
            setInteractionUiEnabled(false);
            await displayFriendList();
            if (pendingConnectionFriendId) {
                await createOfferForPeer(pendingConnectionFriendId); [cite: 1848]
                pendingConnectionFriendId = null; [cite: 1849]
            }
            // ↓↓↓ FCM Token Request Addition ↓↓↓
            if (typeof messaging !== 'undefined' && myDeviceId) {
                await requestFCMToken();
            }
            // ↑↑↑ FCM Token Request Addition ↑↑↑
            break; [cite: 1849, 1850]
        case 'user_list': [cite: 1850]
            onlineFriendsCache.clear(); [cite: 1850, 1851]
            if (dbPromise && message.users && Array.isArray(message.users)) {
                const db = await dbPromise; [cite: 1851, 1852]
                for (const userId of message.users) {
                    if (userId !== myDeviceId && await isFriend(userId, db)) {
                        onlineFriendsCache.add(userId); [cite: 1852, 1853]
                    }
                }
            }
            break; [cite: 1853, 1854]
        case 'user_joined':
        case 'user_online': [cite: 1854]
            const joinedUUID = message.uuid;
            if (joinedUUID && joinedUUID !== myDeviceId) { [cite: 1855]
                await displayFriendList();
                const friendExists = await isFriend(joinedUUID); [cite: 1856]
                if (friendExists) {
                    onlineFriendsCache.add(joinedUUID); [cite: 1856]
                    if (peers[joinedUUID]) { [cite: 1857]
                        if (peers[joinedUUID].connectionState === 'connecting') {
                          return; [cite: 1857, 1858]
                        }
                        const currentState = peers[joinedUUID].connectionState; [cite: 1858, 1859]
                        if (currentState === 'connected' || currentState === 'connecting') {
                        } else { [cite: 1859, 1905]
                            closePeerConnection(joinedUUID);
                            await createOfferForPeer(joinedUUID); [cite: 1860]
                        }
                    } else {
                        await createOfferForPeer(joinedUUID); [cite: 1860, 1861]
                    }
                } else {
                    updateStatus(`Peer ${joinedUUID.substring(0,6)} joined (NOT a friend).`, 'gray'); [cite: 1861, 1862]
                }
            }
            break; [cite: 1862, 1863]
        case 'user_left': [cite: 1863]
            const leftUUID = message.uuid;
            if (leftUUID && leftUUID !== myDeviceId) { [cite: 1864]
                onlineFriendsCache.delete(leftUUID);
                updateStatus(`Peer ${leftUUID.substring(0,6)} left`, 'orange'); [cite: 1864]
                closePeerConnection(leftUUID);
                await displayFriendList(); [cite: 1865]
             }
            break; [cite: 1865, 1866]
        case 'offer': [cite: 1866]
            if (senderUUID) {;
                await handleOfferAndCreateAnswer(senderUUID, payload.sdp); [cite: 1866, 1867]
            }
            break; [cite: 1867, 1868]
        case 'answer': [cite: 1868]
             if (senderUUID) {
                console.log(`Received answer from ${senderUUID}`); [cite: 1868, 1869]
                await handleAnswer(senderUUID, payload.sdp);
            } else { console.warn("Answer received without sender UUID"); [cite: 1869, 1870]
            }
            break; [cite: 1870, 1871]
        case 'ice-candidate': [cite: 1871]
             if (senderUUID) {
                await handleIceCandidate(senderUUID, payload.candidate); [cite: 1871, 1872]
            }
            break; [cite: 1872, 1873]
        case 'call-request': [cite: 1873]
             if (senderUUID) {
                handleIncomingCall(senderUUID); [cite: 1873, 1874]
            }
            break; [cite: 1874, 1875]
        case 'call-accepted': [cite: 1875]
             if (senderUUID) {
                updateStatus(`Call accepted by ${senderUUID.substring(0,6)}. Connecting...`, 'blue'); [cite: 1875, 1876]
                await createOfferForPeer(senderUUID);
            }
            break; [cite: 1876, 1877]
        case 'call-rejected': [cite: 1877]
             if (senderUUID) {
                handleCallRejected(senderUUID); [cite: 1877, 1878]
            }
            break; [cite: 1878, 1879]
        case 'call-busy': [cite: 1879]
             if (senderUUID) {
                handleCallBusy(senderUUID); [cite: 1879, 1880]
            }
            break; [cite: 1880, 1881]
      }
    } catch (error) { [cite: 1881]
    }
  };
  signalingSocket.onclose = async (event) => { [cite: 1882]
    const code = event.code;
    const reason = event.reason; [cite: 1882, 1883]
    console.log(`WebSocket disconnected: Code=${code}, Reason='${reason}', Current Attempts=${wsReconnectAttempts}`);
    const socketInstanceThatClosed = event.target; [cite: 1883, 1884]
    if (socketInstanceThatClosed) {
        socketInstanceThatClosed.onopen = null;
        socketInstanceThatClosed.onmessage = null;
        socketInstanceThatClosed.onerror = null; [cite: 1884, 1885]
        socketInstanceThatClosed.onclose = null;
    }
    if (signalingSocket !== socketInstanceThatClosed && signalingSocket !== null) { [cite: 1885, 1886]
        return;
    }
    signalingSocket = null;

    if ((code === 1000 || code === 1001) && !isAttemptingReconnect) { [cite: 1886]
        updateStatus('Signaling connection closed.', 'orange'); [cite: 1887]
        resetConnection();
        await displayFriendList();
        return;
      }
      if (wsReconnectAttempts >= MAX_WS_RECONNECT_ATTEMPTS && isAttemptingReconnect) { [cite: 1887]
        updateStatus('Signaling connection lost. Please refresh the page.', 'red'); [cite: 1888]
        resetConnection();
        await displayFriendList();
        isAttemptingReconnect = false;
        wsReconnectAttempts = 0; [cite: 1888, 1889]
        return;
      }
      if (!isAttemptingReconnect) { [cite: 1889]
        isAttemptingReconnect = true;
        wsReconnectAttempts = 0; [cite: 1890]
      }
      wsReconnectAttempts++;
      let delay = INITIAL_WS_RECONNECT_DELAY_MS * Math.pow(1.5, wsReconnectAttempts - 1); [cite: 1890, 1891]
      delay = Math.min(delay, MAX_WS_RECONNECT_DELAY_MS);
      updateStatus(`Signaling disconnected. Reconnecting in ${Math.round(delay/1000)}s (Attempt ${wsReconnectAttempts}/${MAX_WS_RECONNECT_ATTEMPTS})...`, 'orange'); [cite: 1891]
      Object.keys(peers).forEach(peerUUID => closePeerConnection(peerUUID));
      Object.values(dataChannels).forEach(channel => { if (channel && channel.readyState !== 'closed') channel.close(); }); [cite: 1892]
      dataChannels = {};
      setInteractionUiEnabled(false);
      currentAppState = AppState.CONNECTING; [cite: 1892, 1893]
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(async () => { [cite: 1893]
        await connectWebSocket();
      }, delay);
  }; [cite: 1894]
  signalingSocket.onerror = (error) => { [cite: 1894]
    if (signalingSocket && (signalingSocket.readyState === WebSocket.OPEN || signalingSocket.readyState === WebSocket.CONNECTING)) {
        signalingSocket.close(); [cite: 1894, 1895]
    } else if (!signalingSocket && !isAttemptingReconnect) {
    }
  }; [cite: 1895, 1896]
}
function sendSignalingMessage(message) { [cite: 1896]
  if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
    if (!message.payload) message.payload = {}; [cite: 1896, 1897]
    if (!message.payload.uuid) message.payload.uuid = myDeviceId;
    signalingSocket.send(JSON.stringify(message)); [cite: 1897]
  } else {
    updateStatus('Signaling connection not ready.', 'red'); [cite: 1897, 1898]
  }
}
function startAutoConnectFriendsTimer() { [cite: 1898]
  if (autoConnectFriendsTimer) {
      clearInterval(autoConnectFriendsTimer); [cite: 1898]
  }
  autoConnectFriendsTimer = setInterval(attemptAutoConnectToFriends, AUTO_CONNECT_INTERVAL);
  attemptAutoConnectToFriends(); [cite: 1899]
}
function stopAutoConnectFriendsTimer() { [cite: 1899]
  if (autoConnectFriendsTimer) {
      clearInterval(autoConnectFriendsTimer); [cite: 1900]
      autoConnectFriendsTimer = null;
  }
} [cite: 1900]
async function attemptAutoConnectToFriends() { [cite: 1900]
  if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
      return; [cite: 1901]
  }
  if (currentAppState === AppState.CONNECTING && Object.keys(peers).some(id => peers[id]?.connectionState === 'connecting')) {
      return; [cite: 1901, 1902]
  }
  if (!dbPromise) {
      return; [cite: 1902, 1903]
  }
  try {
      const db = await dbPromise; [cite: 1903, 1904]
      const friends = await db.getAll('friends');
      if (friends.length === 0) return; [cite: 1904]
      for (const friend of friends) {
          if (friend.id === myDeviceId) continue; [cite: 1905]
          const isPeerConnectedOrConnecting = peers[friend.id] && (peers[friend.id].connectionState === 'connected' || peers[friend.id].connectionState === 'connecting' || peers[friend.id].connectionState === 'new'); [cite: 1905, 1906]
          const isPeerUnderIndividualReconnect = peerReconnectInfo[friend.id] && peerReconnectInfo[friend.id].isReconnecting;
          if (onlineFriendsCache.has(friend.id) && !isPeerConnectedOrConnecting && !isPeerUnderIndividualReconnect) { [cite: 1906, 1907]
              updateStatus(`Auto-connecting to ${friend.id.substring(0,6)}...`, 'blue');
              await createOfferForPeer(friend.id, true); [cite: 1907]
          }
      }
  } catch (error) { [cite: 1907]
  }
}
async function startPeerReconnect(peerUUID) { [cite: 1907, 1908]
    if (!peers[peerUUID] || (peerReconnectInfo[peerUUID] && peerReconnectInfo[peerUUID].isReconnecting)) {
        return; [cite: 1908]
    }
    if (!await isFriend(peerUUID)) {
        closePeerConnection(peerUUID); [cite: 1908, 1909]
        return;
    }
    peerReconnectInfo[peerUUID] = { [cite: 1909, 1910]
        attempts: 0,
        timerId: null,
        isReconnecting: true
    };
    schedulePeerReconnectAttempt(peerUUID); [cite: 1910]
}
function schedulePeerReconnectAttempt(peerUUID) { [cite: 1910, 1911]
    const info = peerReconnectInfo[peerUUID];
    if (!info || !info.isReconnecting) { [cite: 1911]
        return;
    }
    info.attempts++; [cite: 1912]
    if (info.attempts > MAX_PEER_RECONNECT_ATTEMPTS) {
        updateStatus(`Failed to reconnect with ${peerUUID.substring(0,6)}.`, 'red'); [cite: 1912, 1913]
        info.isReconnecting = false;
        closePeerConnection(peerUUID); [cite: 1913]
        return;
    }
    let delay = INITIAL_PEER_RECONNECT_DELAY_MS * Math.pow(1.5, info.attempts - 1); [cite: 1913, 1914]
    delay = Math.min(delay, 30000);
    updateStatus(`Reconnecting to ${peerUUID.substring(0,6)} (attempt ${info.attempts})...`, 'orange'); [cite: 1914]
    if (info.timerId) clearTimeout(info.timerId);
    info.timerId = setTimeout(async () => { [cite: 1915]
        if (!info || !info.isReconnecting) return;
        if (peers[peerUUID] && peers[peerUUID].connectionState !== 'closed' && peers[peerUUID].connectionState !== 'failed') {
            closePeerConnection(peerUUID, true);
        }
        if (!peers[peerUUID]) {
            await createOfferForPeer(peerUUID, true);
        } [cite: 1915, 1916]
    }, delay);
}
function stopPeerReconnect(peerUUID) { [cite: 1916]
    const info = peerReconnectInfo[peerUUID];
    if (info) { [cite: 1917]
        if (info.timerId) clearTimeout(info.timerId);
        info.isReconnecting = false; [cite: 1917]
        delete peerReconnectInfo[peerUUID]; [cite: 1918]
    }
}
function setNegotiationTimeout(peerUUID) { [cite: 1918]
    if (peerNegotiationTimers[peerUUID]) {
        clearTimeout(peerNegotiationTimers[peerUUID]); [cite: 1918, 1919]
    }
    peerNegotiationTimers[peerUUID] = setTimeout(async () => {
        if (peers[peerUUID] && peers[peerUUID].connectionState !== 'connected') { [cite: 1919]
            updateStatus(`Connection attempt with ${peerUUID.substring(0,6)} timed out. Retrying...`, 'orange');
            const isCurrentlyFriend = await isFriend(peerUUID); [cite: 1919, 1920]
            closePeerConnection(peerUUID, true);
            if (isCurrentlyFriend && signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
         
                startPeerReconnect(peerUUID); [cite: 1920]
            } else {
            }
        }
        delete peerNegotiationTimers[peerUUID]; [cite: 1920, 1921]
    }, NEGOTIATION_TIMEOUT_MS);
}
function clearNegotiationTimeout(peerUUID) { [cite: 1921]
    if (peerNegotiationTimers[peerUUID]) {
        clearTimeout(peerNegotiationTimers[peerUUID]); [cite: 1922]
        delete peerNegotiationTimers[peerUUID];
    }
} [cite: 1922]
async function createPeerConnection(peerUUID) { [cite: 1922]
  if (peers[peerUUID]) {
    console.warn(`Closing existing PeerConnection for ${peerUUID}.`); [cite: 1922, 1923]
    closePeerConnection(peerUUID, true);
  }
  clearNegotiationTimeout(peerUUID); [cite: 1923]
  iceCandidateQueue[peerUUID] = [];
  try {
    const peer = new RTCPeerConnection({ [cite: 1923, 1924]
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peer.onicecandidate = event => { [cite: 1924]
      if (event.candidate) {
        sendSignalingMessage({
            type: 'ice-candidate',
            payload: { target: peerUUID, candidate: event.candidate }
        }); [cite: 1925]
      } else {
      } [cite: 1925, 1926]
    };
    peer.ondatachannel = event => { [cite: 1926]
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      setupDataChannelEvents(peerUUID, channel);
    }; [cite: 1927]
    peer.ontrack = (event) => { [cite: 1927]
      handleRemoteTrack(peerUUID, event.track, event.streams[0]);
    };
    peer.onconnectionstatechange = async () => { [cite: 1928]
      switch (peer.connectionState) {
        case 'connected':
          updateStatus(`Connected with ${peerUUID.substring(0,6)}!`, 'green'); [cite: 1928, 1929]
          clearNegotiationTimeout(peerUUID);
          if (peerReconnectInfo[peerUUID] && peerReconnectInfo[peerUUID].isReconnecting) { [cite: 1929, 1930]
            stopPeerReconnect(peerUUID);
          }
          const connectedPeers = Object.values(peers).filter(p => p?.connectionState === 'connected'); [cite: 1930, 1931]
          if (connectedPeers.length > 0 && (messageInputElement && !messageInputElement.disabled)) {
          } else if (connectedPeers.length > 0) { [cite: 1931]
              setInteractionUiEnabled(true);
              currentAppState = AppState.CONNECTED; [cite: 1932]
          }
          break; [cite: 1932, 1933]
        case 'disconnected':
        case 'failed': [cite: 1933]
          updateStatus(`Connection with ${peerUUID.substring(0,6)} ${peer.connectionState}`, 'orange');
          clearNegotiationTimeout(peerUUID); [cite: 1934]
          if (await isFriend(peerUUID) && (!peerReconnectInfo[peerUUID] || !peerReconnectInfo[peerUUID].isReconnecting)) {
            if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) { [cite: 1934]
                 startPeerReconnect(peerUUID);
            } else { [cite: 1935]
                 closePeerConnection(peerUUID); [cite: 1936]
            }
          }
          const stillConnectedPeers = Object.values(peers).filter(p => p?.connectionState === 'connected'); [cite: 1936, 1937]
          if (stillConnectedPeers.length === 0 && currentAppState !== AppState.CONNECTING) {
              setInteractionUiEnabled(false); [cite: 1937, 1938]
              currentAppState = AppState.INITIAL; updateStatus('All peers disconnected.', 'orange');
          }
          break; [cite: 1938, 1939]
        case 'closed': [cite: 1939]
          updateStatus(`Connection with ${peerUUID.substring(0,6)} closed.`, 'orange');
          clearNegotiationTimeout(peerUUID); [cite: 1939]
          stopPeerReconnect(peerUUID); [cite: 1940]
          if (peers[peerUUID]) {
              closePeerConnection(peerUUID, true); [cite: 1940, 1941]
          }
          const stillConnectedPeersAfterClose = Object.values(peers).filter(p => p?.connectionState === 'connected'); [cite: 1941, 1942]
          if (stillConnectedPeersAfterClose.length === 0 && currentAppState !== AppState.CONNECTING) {
              setInteractionUiEnabled(false); [cite: 1942, 1943]
              currentAppState = AppState.INITIAL;
              updateStatus('All peers disconnected or connections closed.', 'orange'); [cite: 1943, 1944]
          }
          break; [cite: 1944, 1945]
        case 'connecting': [cite: 1945]
          updateStatus(`Connecting with ${peerUUID.substring(0,6)}...`, 'orange');
          break; [cite: 1946]
        default:
             updateStatus(`Connection state with ${peerUUID.substring(0,6)}: ${peer.connectionState}`, 'orange'); [cite: 1946, 1947]
      }
    };
    peers[peerUUID] = peer; [cite: 1947]
    return peer;
  } catch (error) { [cite: 1948]
    updateStatus(`Connection setup error: ${error.message}`, 'red');
    currentAppState = AppState.ERROR; [cite: 1948]
    return null;
  }
} [cite: 1949]
function setupDataChannelEvents(peerUUID, channel) { [cite: 1949]
    if (!channel) return;
    dataChannels[peerUUID] = channel; [cite: 1949, 1950]
    channel.onmessage = (event) => handleDataChannelMessage(event, peerUUID);
    channel.onopen = () => { [cite: 1950]
        const openPeers = Object.entries(dataChannels)
                                .filter(([uuid, dc]) => dc && dc.readyState === 'open')
                                .map(([uuid, dc]) => uuid.substring(0,6)); [cite: 1951]
        if (openPeers.length > 0) {
            setInteractionUiEnabled(true); [cite: 1951]
            currentAppState = AppState.CONNECTED;
            updateStatus(`Ready to chat/send files with: ${openPeers.join(', ')}!`, 'green'); [cite: 1952]
        } else {
            setInteractionUiEnabled(false); [cite: 1952, 1953]
        }
    };
    channel.onclose = () => { [cite: 1953]
        delete dataChannels[peerUUID]; [cite: 1954]
        const openPeers = Object.entries(dataChannels)
                                .filter(([uuid, dc]) => dc && dc.readyState === 'open')
                                .map(([uuid, dc]) => uuid.substring(0,6)); [cite: 1954, 1955]
        if (openPeers.length === 0) {
            updateStatus(`Data channel with ${peerUUID.substring(0,6)} closed. No active data channels.`, 'orange'); [cite: 1955]
            setInteractionUiEnabled(false); [cite: 1956]
        } else {
            updateStatus(`Data channel with ${peerUUID.substring(0,6)} closed. Still ready with: ${openPeers.join(', ')}!`, 'orange'); [cite: 1956, 1957]
        }
    };
    channel.onerror = (error) => { [cite: 1957, 1958]
        updateStatus(`Data channel error: ${error}`, 'red');
        closePeerConnection(peerUUID); [cite: 1958]
    };
}
async function createOfferForPeer(peerUUID, isReconnectAttempt = false) { [cite: 1958, 1959]
    currentAppState = AppState.CONNECTING;
    const peer = await createPeerConnection(peerUUID);
    if (!peer) return; [cite: 1959]
    const offerSdp = await createOfferAndSetLocal(peerUUID);
    if (offerSdp) { [cite: 1959, 1960]
        sendSignalingMessage({
            type: 'offer',
            payload: { target: peerUUID, sdp: offerSdp }
        });
        setNegotiationTimeout(peerUUID); [cite: 1960]
    } else {
        closePeerConnection(peerUUID); [cite: 1961]
    }
}
async function createOfferAndSetLocal(peerUUID) { [cite: 1961]
  const peer = peers[peerUUID];
  if (!peer) { [cite: 1961, 1962]
      return null;
  }
  try {
    const channel = peer.createDataChannel('cybernetcall-data'); [cite: 1962, 1963]
    channel.binaryType = 'arraybuffer';
    setupDataChannelEvents(peerUUID, channel);
    if (localStream) { [cite: 1963]
        localStream.getTracks().forEach(track => {
            try {
                peer.addTrack(track, localStream);
            } catch (e) { } [cite: 1963, 1964]
        });
    }
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer); [cite: 1964, 1965]
    return peer.localDescription;
  } catch (error) {
    updateStatus(`Offer creation error for ${peerUUID}: ${error.message}`, 'red'); [cite: 1965, 1966]
    return null;
  }
} [cite: 1966]
async function handleOfferAndCreateAnswer(peerUUID, offerSdp) { [cite: 1966]
  let peer = peers[peerUUID];
  const isRenegotiation = !!peer; [cite: 1967]
  if (!isRenegotiation) {
    iceCandidateQueue[peerUUID] = []; [cite: 1967, 1968]
    peer = await createPeerConnection(peerUUID);
    if (!peer) { [cite: 1968]
        return;
    }
    const alreadyFriend = await isFriend(peerUUID); [cite: 1968, 1969]
    if (!alreadyFriend) {
        await addFriend(peerUUID); [cite: 1969, 1970]
    }
  }
  try {
    await peer.setRemoteDescription(new RTCSessionDescription(offerSdp));
    await processIceCandidateQueue(peerUUID); [cite: 1970, 1971]
    if (localStream) {
        localStream.getTracks().forEach(track => { [cite: 1971]
            try {
                const senderExists = peer.getSenders().find(s => s.track === track);
                if (!senderExists) { [cite: 1971, 1972]
                    peer.addTrack(track, localStream);
             
                }
            } catch (e) { } [cite: 1972, 1973]
        });
    }
    const answer = await peer.createAnswer(); [cite: 1973]
    await peer.setLocalDescription(answer);
    sendSignalingMessage({ [cite: 1974]
        type: 'answer',
        payload: { target: peerUUID, sdp: peer.localDescription }
    });
    setNegotiationTimeout(peerUUID); [cite: 1975]
  } catch (error) {
    updateStatus(`Offer handling / Answer creation error for ${peerUUID}: ${error.message}`, 'red'); [cite: 1975, 1976]
    closePeerConnection(peerUUID);
  }
} [cite: 1976]
async function handleAnswer(peerUUID, answerSdp) { [cite: 1976, 1977]
  const peer = peers[peerUUID];
  if (!peer) { [cite: 1977]
       return null;
  }
  const isRenegotiationAnswer = peer.signalingState === 'have-local-offer'; [cite: 1977, 1978]
  try {
    await peer.setRemoteDescription(new RTCSessionDescription(answerSdp));
    await processIceCandidateQueue(peerUUID); [cite: 1978, 1979]
    return true;
  } catch (error) {
    updateStatus(`Answer handling error for ${peerUUID}: ${error.message}`, 'red'); [cite: 1979, 1980]
    return false;
  }
} [cite: 1980]
async function handleIceCandidate(peerUUID, candidateData) { [cite: 1980, 1981]
    try {
        const peer = peers[peerUUID]; [cite: 1981]
        if (!peer) {
            if (!iceCandidateQueue[peerUUID]) { [cite: 1981, 1982]
                iceCandidateQueue[peerUUID] = [];
            }
            iceCandidateQueue[peerUUID].push(candidateData); [cite: 1982, 1983]
            return;
        }
        if (candidateData) { [cite: 1983]
            if (peer.remoteDescription) {
                await peer.addIceCandidate(new RTCIceCandidate(candidateData)); [cite: 1983, 1984]
            } else {
                if (!iceCandidateQueue[peerUUID]) { [cite: 1984, 1985]
                    iceCandidateQueue[peerUUID] = [];
                }
                iceCandidateQueue[peerUUID].push(candidateData); [cite: 1985, 1986]
            }
        }
    } catch (error) { [cite: 1986]
    }
}
async function processIceCandidateQueue(peerUUID) { [cite: 1986, 1969]
    const peer = peers[peerUUID];
    if (peer && peer.remoteDescription && iceCandidateQueue[peerUUID]) { [cite: 1970]
        while (iceCandidateQueue[peerUUID].length > 0) {
            const candidate = iceCandidateQueue[peerUUID].shift(); [cite: 1970]
            try {
                await peer.addIceCandidate(new RTCIceCandidate(candidate)); [cite: 1971]
            } catch (e) { }
        }
    }
}
function resetConnection() { [cite: 1971]
    try {
        if (typeof Html5QrcodeScannerState !== 'undefined' && window.html5QrCodeScanner && window.html5QrCodeScanner.getState() === Html5QrcodeScannerState.SCANNING) {
            window.html5QrCodeScanner.stop().catch(e => console.warn("Error stopping scanner during reset:", e)); [cite: 1971, 1972]
        } else if (window.html5QrCodeScanner) {
            window.html5QrCodeScanner.clear().catch(e => console.warn("Error clearing scanner during reset:", e)); [cite: 1972, 1973]
        }
    } catch(e) { console.warn("Error accessing scanner state during reset:", e); } [cite: 1973]
    if (signalingSocket) {
        signalingSocket.onclose = null; [cite: 1973, 1974]
        signalingSocket.onerror = null;
        signalingSocket.onmessage = null;
        signalingSocket.onopen = null;
        if (signalingSocket.readyState === WebSocket.OPEN || signalingSocket.readyState === WebSocket.CONNECTING) { [cite: 1974]
            signalingSocket.close(1000);
        }
        signalingSocket = null; [cite: 1975]
    }
    Object.values(dataChannels).forEach(channel => {
        if (channel) {
            channel.onmessage = null;
            channel.onopen = null;
            channel.onclose = null;
            channel.onerror = null;
            if (channel.readyState !== 'closed') { channel.close(); } [cite: 1975]
        }
    });
    dataChannels = {}; [cite: 1976]
    Object.keys(peers).forEach(peerUUID => closePeerConnection(peerUUID, true));
    peers = {};
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop()); [cite: 1976]
        localStream = null;
        if(localVideoElement) localVideoElement.srcObject = null;
    }
    if(callButton) callButton.textContent = '📞';
    if(videoButton) videoButton.textContent = '🎥';
    if(remoteVideosContainer) remoteVideosContainer.innerHTML = '';
    currentAppState = AppState.INITIAL;
    setInteractionUiEnabled(false);
    updateStatus('Connection reset.', 'orange');
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    wsReconnectAttempts = 0;
    isAttemptingReconnect = false;
    stopAutoConnectFriendsTimer();
}
function closePeerConnection(peerUUID, resetUI = false) { [cite: 1977]
    const peer = peers[peerUUID];
    if (peer) {
        peer.onicecandidate = null;
        peer.ondatachannel = null;
        peer.ontrack = null;
        peer.onconnectionstatechange = null;
        peer.close();
        delete peers[peerUUID];
    }
    if (dataChannels[peerUUID]) {
        dataChannels[peerUUID].onmessage = null;
        dataChannels[peerUUID].onopen = null;
        dataChannels[peerUUID].onclose = null;
        dataChannels[peerUUID].onerror = null;
        dataChannels[peerUUID].close();
        delete dataChannels[peerUUID];
    }
    delete iceCandidateQueue[peerUUID];
    delete receivedSize[peerUUID];
    delete incomingFileInfo[peerUUID];
    delete lastReceivedFileChunkMeta[peerUUID];
    stopPeerReconnect(peerUUID);
    clearNegotiationTimeout(peerUUID);
    removeRemoteVideoElement(peerUUID);
    if (resetUI) {
        const connectedPeersCount = Object.values(peers).filter(p => p?.connectionState === 'connected').length;
        if (connectedPeersCount === 0 && currentAppState !== AppState.CONNECTING) { [cite: 1978]
            setInteractionUiEnabled(false);
            currentAppState = AppState.INITIAL; [cite: 1979]
            updateStatus(`Connection with ${peerUUID.substring(0,6)} closed. No active connections.`, 'orange');
        } else if (connectedPeersCount > 0) { [cite: 1979, 1980]
            updateStatus(`Connection with ${peerUUID.substring(0,6)} closed. Still connected to others.`, 'orange');
        }
    }
}
function handleDataChannelMessage(event, senderUUID) { [cite: 1980]
    if (event.data instanceof ArrayBuffer) {
        if (lastReceivedFileChunkMeta[senderUUID]) {
            const meta = lastReceivedFileChunkMeta[senderUUID]; [cite: 1980, 1981]
            processFileChunk(meta, event.data);
            lastReceivedFileChunkMeta[senderUUID] = null; [cite: 1981]
        }
    } else if (typeof event.data === 'string') {
        processTextMessage(event.data, senderUUID); [cite: 1981, 1982]
    } else {
    }
}
async function processTextMessage(dataString, senderUUID) { [cite: 1982]
    try {
        const message = JSON.parse(dataString); [cite: 1982, 1983]
        switch (message.type) {
            case 'post':
                message.sender = message.sender || senderUUID;
                await savePost(message);
                displayPost(message, true); [cite: 1983, 1984]
                break;
            case 'direct-message':
                message.sender = message.sender || senderUUID;
                displayDirectMessage(message, false, senderUUID); [cite: 1984]
                break;
            case 'delete-post':
                const postElement = document.getElementById(`post-${message.postId}`); [cite: 1984, 1985]
                if (postElement) {
                    postElement.remove();
                }
                await deletePostFromDb(message.postId);
                break;
            case 'file-metadata':
                incomingFileInfo[message.fileId] = { name: message.name, size: message.size, type: message.fileType }; [cite: 1985, 1986]
                receivedSize[message.fileId] = 0;
                if (fileTransferStatusElement) {
                    fileTransferStatusElement.textContent = `Receiving ${message.name}... 0%`; [cite: 1986]
                }
                break;
            case 'file-chunk':
                lastReceivedFileChunkMeta[senderUUID] = { ...message, senderUUID }; [cite: 1987]
                break;
            default:
                if (!message.type && message.content && message.id) {
                    await savePost(message); [cite: 1987, 1988]
                    displayPost(message, true);
                }
        }
    } catch (error) { [cite: 1988]
    }
}
async function processFileChunk(chunkMeta, chunkDataAsArrayBuffer) { [cite: 1988]
    const { fileId, index, last, senderUUID } = chunkMeta;
    if (!dbPromise) {
        updateStatus(`DB not ready. Cannot save chunk for ${fileId.substring(0, 6)}.`, 'red');
        return;
    }
    const db = await dbPromise;
    try {
        const fileInfo = incomingFileInfo[fileId];
        if (!fileInfo) throw new Error(`Metadata not found for file ${fileId}`);
        const dataLength = chunkDataAsArrayBuffer.byteLength;
        receivedSize[fileId] += dataLength;
        const progress = Math.round((receivedSize[fileId] / fileInfo.size) * 100);
        if (fileTransferStatusElement) fileTransferStatusElement.textContent = `Receiving ${fileInfo.name}... ${progress}%`;

        // チャンクをDBに保存
        const tx = db.transaction('fileChunks', 'readwrite');
        await tx.store.put({ fileId: fileId, chunkIndex: index, data: chunkDataAsArrayBuffer });
        await tx.done;

        if (last) {
            updateStatus(`File ${fileInfo.name} transfer complete. Assembling...`, 'blue');
            // ファイルの再構成
            const assembleTx = db.transaction('fileChunks', 'readonly');
            const allChunksForFileFromDb = await assembleTx.objectStore('fileChunks').index('by_fileId').getAll(fileId);
            const expectedChunks = Math.ceil(fileInfo.size / CHUNK_SIZE);

            if (allChunksForFileFromDb.length !== expectedChunks) {
                updateStatus(`Error receiving ${fileInfo.name}: Expected ${expectedChunks} chunks, got ${allChunksForFileFromDb.length} from DB. Cannot assemble.`, 'red');
                if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Error receiving ${fileInfo.name} (missing chunks from DB)`);
                await cleanupFileTransferData(fileId, db);
                return;
            }

            // チャンクをインデックス順にソートしてデータを取得
            allChunksForFileFromDb.sort((a, b) => a.chunkIndex - b.chunkIndex);
            const orderedChunkData = allChunksForFileFromDb.map(c => c.data);
            const fileBlob = new Blob(orderedChunkData, { type: fileInfo.type });

            const downloadLink = document.createElement('a');
            downloadLink.href = URL.createObjectURL(fileBlob);
            downloadLink.download = fileInfo.name;
            downloadLink.textContent = `Download ${fileInfo.name}`;
            downloadLink.style.display = 'block';
            downloadLink.style.marginTop = '5px';

            if (fileTransferStatusElement) {
                fileTransferStatusElement.innerHTML = '';
                fileTransferStatusElement.appendChild(downloadLink);
            } else {
                messageAreaElement.appendChild(downloadLink);
            }
            await cleanupFileTransferData(fileId, db, true);
        }
    } catch (error) {
        updateStatus(`Error processing chunk for ${incomingFileInfo[fileId]?.name || 'unknown file'}: ${error.message}`, 'red');
        if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Error processing chunk for ${incomingFileInfo[fileId]?.name || 'unknown file'}`);
        await cleanupFileTransferData(fileId, db);
    }
}
function broadcastMessage(messageString) { [cite: 1988]
    let sentToAtLeastOne = false;
    const openChannels = Object.entries(dataChannels).filter(([uuid, dc]) => dc && dc.readyState === 'open'); [cite: 1989]
    if (openChannels.length > 0) {
        openChannels.forEach(([uuid, dc]) => {
            try {
                dc.send(messageString);
                sentToAtLeastOne = true;
            } catch (error) { console.error(`Error sending message to ${uuid}:`, error); } [cite: 1989, 1990]
        });
    } else {
        console.warn("Cannot broadcast message: No open DataChannels."); [cite: 1990]
    }
    return sentToAtLeastOne; [cite: 1991]
}
async function cleanupFileTransferData(fileId, db, transferComplete = false) { [cite: 1991]
    if (db) {
        try {
            const deleteTx = db.transaction('fileChunks', 'readwrite'); [cite: 1992]
            const allChunksForFile = await deleteTx.objectStore('fileChunks').index('by_fileId').getAll(fileId);
            allChunksForFile.forEach(chunk => deleteTx.objectStore('fileChunks').delete([chunk.fileId, chunk.chunkIndex]));
            await deleteTx.done;
        } catch (e) { console.error("DB cleanup failed:", e); }
    }
    delete incomingFileInfo[fileId];
    delete receivedSize[fileId];
    // senderUUIDごとのlastReceivedFileChunkMetaは、次に来るチャンクのメタデータなのでクリア不要だが、念のため関連データは削除
    Object.keys(lastReceivedFileChunkMeta).forEach(senderUUID => {
        if (lastReceivedFileChunkMeta[senderUUID]?.fileId === fileId) {
            delete lastReceivedFileChunkMeta[senderUUID];
        }
    });
}
function broadcastBinaryData(chunkDataAsArrayBuffer) { [cite: 1992]
    let sentToAtLeastOne = false;
    const openChannels = Object.entries(dataChannels).filter(([uuid, dc]) => dc && dc.readyState === 'open' && dc.bufferedAmount === 0);
    if (openChannels.length > 0) {
        openChannels.forEach(([uuid, dc]) => {
            try {
                dc.send(chunkDataAsArrayBuffer);
                sentToAtLeastOne = true;
            } catch (error) { console.error(`Error sending binary data to ${uuid}:`, error); }
        });
    } else {
        console.warn("Cannot broadcast binary data: No open DataChannels or bufferedAmount > 0.");
    }
    return sentToAtLeastOne;
}
function displayDirectMessage(message, isOutgoing, senderUUID = null) { [cite: 1993]
    if (!messageAreaElement) return;
    const div = document.createElement('div');
    div.className = isOutgoing ? 'message outgoing' : 'message incoming'; [cite: 1994]
    let senderName = 'You';
    if (!isOutgoing) {
        senderName = `Peer (${senderUUID ? senderUUID.substring(0, 6) : 'Unknown'})`;
    } else if (message.sender) { [cite: 1994]
        senderName = `Peer (${message.sender.substring(0, 6)})`;
    }
    const linkedContent = linkify(message.content); [cite: 1994, 1995]
    div.innerHTML = DOMPurify.sanitize(`<strong>${senderName}:</strong> ${linkedContent}`);
    messageAreaElement.appendChild(div);
    messageAreaElement.scrollTop = messageAreaElement.scrollHeight; [cite: 1995]
}
async function handleSendPost() { [cite: 1995]
    const input = postInputElement;
    const content = input?.value?.trim(); [cite: 1996]
    if (content) {
        const post = {
            type: 'post',
            id: generateUUID(),
            content: content,
            sender: myDeviceId, [cite: 1996]
            timestamp: new Date().toISOString()
        };
        await savePost(post); [cite: 1997]
        displayPost(post, true);
        const postString = JSON.stringify(post);
        if (!broadcastMessage(postString)) {
            alert("Not connected. Post saved locally only."); [cite: 1998]
        }
        if(input) input.value = '';
    }
}
function handleSendFile() { [cite: 1998]
    if (!fileInputElement || !fileInputElement.files || fileInputElement.files.length === 0) {
        alert("Please select a file."); [cite: 1999]
        return;
    }
    const openChannels = Object.entries(dataChannels).filter(([uuid, dc]) => dc && dc.readyState === 'open'); [cite: 1999, 2000]
    if (openChannels.length === 0) {
        console.warn("Send file clicked but no open data channels.");
        alert("Not connected to any peers to send the file."); [cite: 2000]
        return;
    }
    const file = fileInputElement.files[0];
    const snapshottedFileSize = file.size; [cite: 2001]
    const fileId = generateUUID();
    if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Sending ${file.name}... 0%`); [cite: 2001, 2002]
    sendFileButton.disabled = true;
    const metadata = {
        type: 'file-metadata',
        fileId: fileId,
        name: file.name,
        size: snapshottedFileSize,
        fileType: file.type [cite: 2002]
    };
    const metadataString = JSON.stringify(metadata); [cite: 2003]
    if (!broadcastMessage(metadataString)) {
        alert("Failed to send file metadata to any peer.");
        sendFileButton.disabled = false; [cite: 2003, 2004]
        return;
    }
    fileReader = new FileReader(); [cite: 2004]
    let offset = 0;
    let chunkIndex = 0;
    const readSlice = (o) => { [cite: 2005]
        const slice = file.slice(o, o + CHUNK_SIZE);
        fileReader.readAsArrayBuffer(slice);
    };
    fileReader.onload = async (e) => { [cite: 2006]
        const chunkDataAsArrayBuffer = e.target.result;
        const currentFileId = fileId;
        const originalFileName = file.name;
        const originalFileSizeInLogic = snapshottedFileSize;
        const currentChunkIndex = chunkIndex;
        const currentOffset = offset;

        const sendFileChunk = async (chunkDataAsArrayBuffer, originalFileName, originalFileSizeInLogic, currentFileId, currentChunkIndex, currentOffset, retryCount = 0) => {
            try {
                const chunkMetaMessage = {
                    type: 'file-chunk',
                    fileId: currentFileId,
                    index: currentChunkIndex,
                    last: ((currentOffset + chunkDataAsArrayBuffer.byteLength) >= originalFileSizeInLogic)
                }; [cite: 2007]
                const metaString = JSON.stringify(chunkMetaMessage);
                if (!broadcastMessage(metaString)) { [cite: 2007, 2008]
                    if (retryCount < 3) throw new Error(`Failed to send chunk meta ${currentChunkIndex} to any peer.`);
                    else { console.error(`Failed to send chunk meta ${currentChunkIndex} after multiple retries.`); [cite: 2008]
                    }
                }
                setTimeout(() => {
                    if (!broadcastBinaryData(chunkDataAsArrayBuffer)) { [cite: 2008, 2009]
                        if (retryCount < 3) throw new Error(`Failed to send chunk data ${currentChunkIndex} to any peer.`);
                        else { console.error(`Failed to send chunk data ${currentChunkIndex} after multiple retries.`); } [cite: 2009]
                    }
                    const newOffset = currentOffset + chunkDataAsArrayBuffer.byteLength;
                    const progress = Math.round((newOffset / originalFileSizeInLogic) * 100);
                    if (fileTransferStatusElement) fileTransferStatusElement.textContent = `Sending ${originalFileName}... ${progress}%`;
                    if (newOffset < originalFileSizeInLogic) {
                        offset = newOffset;
                        chunkIndex++;
                        setTimeout(() => readSlice(newOffset), 0);
                    } else { [cite: 2010]
                        if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Sent ${originalFileName}`);
                        if(fileInputElement) fileInputElement.value = ''; [cite: 2010]
                        sendFileButton.disabled = false;
                    }
                }, 10);
            } catch (error) { [cite: 2011]
                console.error(`Error sending chunk ${currentChunkIndex}:`, error);
                if (retryCount < 3) { [cite: 2011]
                    setTimeout(() => sendFileChunk(chunkDataAsArrayBuffer, originalFileName, originalFileSizeInLogic, currentFileId, currentChunkIndex, currentOffset, retryCount + 1), 1000 * (retryCount + 1));
                } else { [cite: 2012]
                    alert(`Failed to send chunk ${currentChunkIndex} after multiple retries.`);
                    if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize('Chunk send error'); [cite: 2012]
                    sendFileButton.disabled = false;
                }
            }
        };

        await sendFileChunk(chunkDataAsArrayBuffer, originalFileName, originalFileSizeInLogic, currentFileId, currentChunkIndex, currentOffset);
    };

    fileReader.onerror = (e) => {
        updateStatus(`FileReader error: ${e.target.error}`, 'red');
        sendFileButton.disabled = false;
    };

    readSlice(0);
}
function handleCallClick() {
    if (localStream) {
        // ... (Call termination logic) [cite: 2013, 2014, 2015]
    } else {
        // ... (Call initiation logic)
    }
}
function handleVideoClick() {
    // ... (Toggle local video logic) [cite: 2016]
}
function handleRemoteTrack(peerUUID, track, stream) {
    // ... (Handle remote video logic)
}
function removeRemoteVideoElement(peerUUID) {
    // ... (Remove remote video element logic)
}
function renderRemoteVideos() {
    // ... (Render remote videos logic)
}
function handleScanButtonClick() {
    // ... (QR code scanner logic)
}
function startQrScanner() {
    // ... (QR code scanner logic)
}
function handleScannedQrData(decodedText) {
    // ... (Handle scanned QR data logic)
}
function handleCallFriendClick(event) {
    // ... (Call friend logic)
}
function handleIncomingCall(callerId) {
    // ... (Handle incoming call logic)
}
function handleAcceptCall() {
    // ... (Accept call logic)
}
function handleRejectCall() {
    // ... (Reject call logic)
}
function handleCallRejected(peerId) {
    // ... (Handle call rejected logic)
}
function handleCallBusy(peerId) {
    // ... (Handle call busy logic)
}

// ... (other functions: createAndSendOfferForRenegotiation, toggleLocalVideo, etc.)

// Original Initialization Block (Reconstructed and Updated) [cite: 1772, 1773]
window.addEventListener('DOMContentLoaded', async () => {
    // DOM Element Retrieval (Original: [cite: 1769, 1770, 1771])
    qrElement = document.getElementById('qrcode');
    statusElement = document.getElementById('connectionStatus');
    qrReaderElement = document.getElementById('qr-reader');
    qrResultsElement = document.getElementById('qr-reader-results');
    localVideoElement = document.getElementById('localVideo');
    messageAreaElement = document.getElementById('messageArea');
    postAreaElement = document.getElementById('postArea');
    
    // Message/Post Inputs (Original: [cite: 1769, 1770])
    messageInputElement = document.getElementById('messageInput');
    sendMessageButton = document.getElementById('sendMessage');
    postInputElement = document.getElementById('postInput');
    sendPostButton = document.getElementById('sendPost');
    
    // File/Call Controls (Original: [cite: 1770, 1771])
    fileInputElement = document.getElementById('fileInput');
    sendFileButton = document.getElementById('sendFile');
    fileTransferStatusElement = document.getElementById('file-transfer-status');
    callButton = document.getElementById('callButton');
    videoButton = document.getElementById('videoButton');
    startScanButton = document.getElementById('startScanButton');
    
    // Modal/Remote Videos (Original: [cite: 1769, 1771])
    incomingCallModal = document.getElementById('incomingCallModal');
    callerIdElement = document.getElementById('callerId');
    acceptCallButton = document.getElementById('acceptCallButton');
    rejectCallButton = document.getElementById('rejectCallButton');
    friendListElement = document.getElementById('friendList'); // Note: This element doesn't exist in the provided index.html snippet but is referenced here.
    
    if (!remoteVideosContainer) {
        remoteVideosContainer = document.querySelector('.video-scroll-container');
    }

    if (statusElement) {
        statusElement.addEventListener('click', () => {
            statusElement.classList.toggle('status-expanded');
        }); [cite: 1772]
    }

    // Check for myDeviceId (localStorage should be checked first for persistence)
    myDeviceId = localStorage.getItem('myDeviceId');
    if (!myDeviceId) {
        myDeviceId = generateUUID();
        localStorage.setItem('myDeviceId', myDeviceId);
    }
    
    // Display myDeviceId (e.g., in a status bar or title)
    // document.title = `CyberNetCall (${myDeviceId.substring(0, 8)}...)`;

    // QR Code Generation
    if (qrElement && typeof QRious !== 'undefined') {
        new QRious({
            element: qrElement,
            value: `${window.location.origin}/?id=${myDeviceId}`, // Connect URL
            size: 200
        });
    }

    // Event Listeners
    if (sendMessageButton) sendMessageButton.addEventListener('click', handleSendMessage);
    if (postInputElement && sendPostButton) {
        sendPostButton.addEventListener('click', handleSendPost);
        postInputElement.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSendPost();
        });
    }
    if (sendFileButton) sendFileButton.addEventListener('click', handleSendFile);
    if (callButton) callButton.addEventListener('click', handleCallClick);
    if (videoButton) videoButton.addEventListener('click', handleVideoClick);
    if (startScanButton) startScanButton.addEventListener('click', handleScanButtonClick);
    if (acceptCallButton) acceptCallButton.addEventListener('click', handleAcceptCall);
    if (rejectCallButton) rejectCallButton.addEventListener('click', handleRejectCall);

    // Initial Data Load
    await displayInitialPosts();
    
    // --- FCM Initialization (NEW) ---
    if (typeof firebase !== 'undefined') {
        initFCM();
    }
    // --------------------------------
    
    // Service Worker Registration
    if ('serviceWorker' in navigator) {
      // ... (Original Service Worker registration logic)
        navigator.serviceWorker.register('{% static "cnc/sw.js" %}')
            .then(reg => {
                // ... (Original update logic)
                reg.onupdatefound = () => {
                   const installingWorker = reg.installing;
                   installingWorker.onstatechange = () => {
                       if (installingWorker.state === 'installed') {
                           if (navigator.serviceWorker.controller) {
                               // New content available
                               updateStatus('New content available.', 'blue');
                               const refreshing = false;
                               navigator.serviceWorker.addEventListener('controllerchange', () => {
                                   if (refreshing) return;
                                   window.location.reload();
                                   refreshing = true;
                               });
                             } else {
                               updateStatus('Content cached for offline use.', 'blue');
                             }
                        }
                      }
                    };
                })
                .catch(error => {
                    updateStatus(`Service Worker registration error: ${error.message}`, 'red');
                });
    } else {
        updateStatus('Offline features unavailable (Service Worker not supported)', 'orange'); [cite: 1773]
    }
    
    // Service Worker Activation Message Listener
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'APP_ACTIVATED') {
          if ((!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) && !isAttemptingReconnect) {
              connectWebSocket();
          }
          startAutoConnectFriendsTimer();
        }
      });
    }

    // Start WebSocket Connection
    await connectWebSocket();
    startAutoConnectFriendsTimer();
    
    // Handle URL parameters for connection (e.g., from a shared link)
    const urlParams = new URLSearchParams(window.location.search);
    const incomingFriendId = urlParams.get('id');
    if (incomingFriendId && incomingFriendId !== myDeviceId) {
        updateStatus(`Connecting from link with ${incomingFriendId.substring(0,6)}...`, 'blue');
        await addFriend(incomingFriendId);
        pendingConnectionFriendId = incomingFriendId;
    }

});