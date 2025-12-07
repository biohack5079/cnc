let myDeviceId;
let localStream;
let peers = {};
let dataChannels = {};
let signalingSocket = null;
const AppState = {
  INITIAL: 'initial',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
};
let currentAppState = AppState.INITIAL;
let qrElement, statusElement, qrReaderElement, qrResultsElement, localVideoElement, remoteVideoElement, messageAreaElement, postAreaElement;
let messageInputElement, sendMessageButton, postInputElement, sendPostButton;
let fileInputElement, sendFileButton, fileTransferStatusElement;
let callButton, videoButton;
let startScanButton;
let remoteVideosContainer;
let incomingCallModal, callerIdElement, acceptCallButton, rejectCallButton;
let currentCallerId = null;
let friendListElement;
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

// =========================================================================
// 🔔 Web Push Notification Variables and Helpers 🔔 
// =========================================================================

// ⚠️ VAPID Public Key: Django設定で生成されたVAPID Public Keyを正確に入力してください。
const VAPID_PUBLIC_KEY = 'PLACEHOLDER_VAPID_PUBLIC_KEY_MUST_BE_REPLACED'; 

/**
 * URL Base64文字列をUint8Arrayに変換するヘルパー関数 (Web Push購読に必要)
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
// =========================================================================
// 🔔 End of Web Push Variables and Helpers 🔔
// =========================================================================


function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}


function linkify(text) {
    if (!text) return '';


    const urlPattern = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
 text = text.replace(urlPattern, function(url) {
        let fullUrl = url;
        if (!url.match(/^https?:\/\//i) && url.startsWith('www.')) {
            fullUrl = 'http://' + url;
        }
        return `<a href="${fullUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
 const emailPattern = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
    text = text.replace(emailPattern, function(email) {
        return `<a href="mailto:${email}">${email}</a>`;
    });
 return text;
}

function renderStatusMessages() {
    if (!statusElement) return;
    statusElement.innerHTML = '';
 // statusMessages は unshift で追加しているので、そのままの順で表示すると新しいものが上に来る
    statusMessages.forEach(msgObj => {
        const div = document.createElement('div');
        div.textContent = msgObj.text;
        div.style.color = msgObj.color;
        statusElement.appendChild(div);
    });
 statusElement.style.display = statusMessages.length > 0 ? 'block' : 'none';
    // 必要であれば、常に一番下にスクロールする (新しいメッセージが下に追加される場合)
    // statusElement.scrollTop = statusElement.scrollHeight;
 }

function updateStatus(message, color = 'black') {
    if (!statusElement) return;

    const messageText = String(message || '');
 // 明示的に空のメッセージが指定された場合は、全てのステータスをクリアする
    if (messageText === '') {
        statusMessages = [];
 renderStatusMessages();
        return;
    }
    const newMessage = {
        id: generateUUID(), // メッセージごとのユニークID
        text: messageText,
        color: color,
        timestamp: new Date() // タイムスタンプを追加
    };
 statusMessages.unshift(newMessage); // 新しいメッセージを配列の先頭に追加

    if (statusMessages.length > MAX_STATUS_MESSAGES) {
        statusMessages.length = MAX_STATUS_MESSAGES;
 // 配列の末尾 (古いメッセージ) から削除
    }
    renderStatusMessages();
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
async function savePost(post) {
  if (!dbPromise) return;
 try {
    const db = await dbPromise;
    const tx = db.transaction('posts', 'readwrite');
    await tx.store.put(post);
    await tx.done;
 } catch (error) {
  }
}
async function deletePostFromDb(postId) {
  if (!dbPromise) return;
 try {
    const db = await dbPromise;
    const tx = db.transaction('posts', 'readwrite');
    await tx.store.delete(postId);
    await tx.done;
 } catch (error) {
  }
}
async function addFriend(friendId, friendName = null) {
  if (!dbPromise || !friendId) return;
 if (friendId === myDeviceId) {
      alert("You cannot add yourself as a friend.");
      return;
 }
  try {
    const db = await dbPromise;
    const tx = db.transaction('friends', 'readwrite');
 const existing = await tx.store.get(friendId);
    if (existing) {
        updateStatus(`Friend (${friendId.substring(0,6)}) is already added.`, 'orange');
 return;
    }
    await tx.store.put({ id: friendId, name: friendName, added: new Date() });
    await tx.done;
 updateStatus(`Friend (${friendId.substring(0,6)}) added successfully!`, 'green');
    await displayFriendList();
  } catch (error) {
    updateStatus("Failed to add friend.", 'red');
 }
}
async function isFriend(friendId, dbInstance = null) {
  if (!dbPromise || !friendId) return false;
 try {
    const db = dbInstance || await dbPromise;
    const friend = await db.get('friends', friendId);
    return !!friend;
 } catch (error) {
    return false;
  }
}
async function displayFriendList() {
  if (!dbPromise || !friendListElement) return;
 try {
    const db = await dbPromise;
    const friends = await db.getAll('friends');
    friendListElement.innerHTML = '<h3>Friends</h3>';
 if (friends.length === 0) {
        friendListElement.innerHTML += '<p>No friends added yet. Scan their QR code!</p>';
    }
    friends.forEach(friend => displaySingleFriend(friend));
 } catch (error) {
  }
}
async function displayInitialPosts() {
  if (!dbPromise || !postAreaElement) return;
 try {
    const db = await dbPromise;
    const posts = await db.getAll('posts');
    postAreaElement.innerHTML = '';
 posts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    posts.forEach(post => displayPost(post, false));
 } catch (error) {
  }
}
function displayPost(post, isNew = true) {
  if (!postAreaElement) return;
  const div = document.createElement('div');
 div.className = 'post';
  div.id = `post-${post.id}`;
  const contentSpan = document.createElement('span');
  const linkedContent = linkify(post.content);
 contentSpan.innerHTML = DOMPurify.sanitize(`<strong>${post.sender ? post.sender.substring(0, 6) : 'Unknown'}:</strong> ${linkedContent}`);
  const deleteButton = document.createElement('button');
  deleteButton.textContent = '❌';
  deleteButton.className = 'delete-post-button';
 deleteButton.dataset.postId = post.id;
  deleteButton.style.marginLeft = '10px';
  deleteButton.style.cursor = 'pointer';
  deleteButton.style.border = 'none';
  deleteButton.style.background = 'none';
  deleteButton.ariaLabel = 'Delete post';
 deleteButton.addEventListener('click', handleDeletePost);
  div.appendChild(contentSpan);
  div.appendChild(deleteButton);
  if (isNew && postAreaElement.firstChild) {
      postAreaElement.insertBefore(div, postAreaElement.firstChild);
 } else {
      postAreaElement.appendChild(div);
  }
}
async function handleDeletePost(event) {
    const button = event.currentTarget;
 const postId = button.dataset.postId;
    if (!postId) return;
    const postElement = document.getElementById(`post-${postId}`);
 if (postElement) {
        postElement.remove();
    }
    await deletePostFromDb(postId);
 const postDeleteMessage = JSON.stringify({
        type: 'delete-post',
        postId: postId
    });
 broadcastMessage(postDeleteMessage);
}
function displaySingleFriend(friend) {
    if (!friendListElement) return;
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.dataset.friendId = friend.id;
 const nameSpan = document.createElement('span');
    nameSpan.textContent = `ID: ${friend.id.substring(0, 8)}...`;
    const callFriendButton = document.createElement('button');
    callFriendButton.textContent = '📞 Call';
    callFriendButton.dataset.friendId = friend.id;
 callFriendButton.addEventListener('click', handleCallFriendClick);
    callFriendButton.disabled = !signalingSocket || signalingSocket.readyState !== WebSocket.OPEN || currentAppState === AppState.CONNECTING || currentAppState === AppState.CONNECTED;
    div.appendChild(nameSpan);
    div.appendChild(callFriendButton);
    friendListElement.appendChild(div);
 }
async function connectWebSocket() {
  if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
    return;
 }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws/signaling/`;
 updateStatus('Connecting to signaling server...', 'blue');
  signalingSocket = new WebSocket(wsUrl);
  signalingSocket.onopen = () => {
    wsReconnectAttempts = 0;
 isAttemptingReconnect = false;
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
 }
    updateStatus('Connected to signaling server. Registering...', 'blue');
 sendSignalingMessage({
      type: 'register',
      payload: { uuid: myDeviceId }
    });
 };
  signalingSocket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
 const messageType = message.type;
      const payload = message.payload || {};
      const senderUUID = message.from || message.uuid || payload.uuid;
 switch (messageType) {
        case 'registered':
            updateStatus('Connected to signaling server. Ready.', 'green');
 currentAppState = AppState.INITIAL;
            setInteractionUiEnabled(false);
            await displayFriendList();
            if (pendingConnectionFriendId) {
                await createOfferForPeer(pendingConnectionFriendId);
 pendingConnectionFriendId = null;
            }
            break;
 case 'user_list':
            onlineFriendsCache.clear();
 if (dbPromise && message.users && Array.isArray(message.users)) {
                const db = await dbPromise;
 for (const userId of message.users) {
                    if (userId !== myDeviceId && await isFriend(userId, db)) {
                        onlineFriendsCache.add(userId);
 }
                }
            }
            break;
 case 'user_joined':
        case 'user_online':
            const joinedUUID = message.uuid;
 if (joinedUUID && joinedUUID !== myDeviceId) {
                await displayFriendList();
 const friendExists = await isFriend(joinedUUID);
                if (friendExists) {
                    onlineFriendsCache.add(joinedUUID);
 if (peers[joinedUUID]) {
                        if (peers[joinedUUID].connectionState === 'connecting') {
                          return;
 }
                        const currentState = peers[joinedUUID].connectionState;
 if (currentState === 'connected' || currentState === 'connecting') {
                        } else {
                            closePeerConnection(joinedUUID);
 await createOfferForPeer(joinedUUID);
                        }
                    } else {
                        await createOfferForPeer(joinedUUID);
 }
                } else {
                    updateStatus(`Peer ${joinedUUID.substring(0,6)} joined (NOT a friend).`, 'gray');
 }
            }
            break;
 case 'user_left':
            const leftUUID = message.uuid;
 if (leftUUID && leftUUID !== myDeviceId) {
                onlineFriendsCache.delete(leftUUID);
 updateStatus(`Peer ${leftUUID.substring(0,6)} left`, 'orange');
                closePeerConnection(leftUUID);
                await displayFriendList();
             }
            break;
 case 'offer':
            if (senderUUID) {;
                await handleOfferAndCreateAnswer(senderUUID, payload.sdp);
 }
            break;
 case 'answer':
             if (senderUUID) {
                console.log(`Received answer from ${senderUUID}`);
 await handleAnswer(senderUUID, payload.sdp);
            } else { console.warn("Answer received without sender UUID");
 }
            break;
 case 'ice-candidate':
             if (senderUUID) {
                await handleIceCandidate(senderUUID, payload.candidate);
 }
            break;
 case 'call-request':
             if (senderUUID) {
                handleIncomingCall(senderUUID);
 }
            break;
 case 'call-accepted':
             if (senderUUID) {
                updateStatus(`Call accepted by ${senderUUID.substring(0,6)}. Connecting...`, 'blue');
 await createOfferForPeer(senderUUID);
            }
            break;
 case 'call-rejected':
             if (senderUUID) {
                handleCallRejected(senderUUID);
 }
            break;
 case 'call-busy':
             if (senderUUID) {
                handleCallBusy(senderUUID);
 }
            break;
 }
    } catch (error) {
    }
  };
 signalingSocket.onclose = async (event) => {
    const code = event.code;
    const reason = event.reason;
 console.log(`WebSocket disconnected: Code=${code}, Reason='${reason}', Current Attempts=${wsReconnectAttempts}`);
    const socketInstanceThatClosed = event.target;
 if (socketInstanceThatClosed) {
        socketInstanceThatClosed.onopen = null;
        socketInstanceThatClosed.onmessage = null;
        socketInstanceThatClosed.onerror = null;
 socketInstanceThatClosed.onclose = null;
    }
    if (signalingSocket !== socketInstanceThatClosed && signalingSocket !== null) {
        return;
 }
    signalingSocket = null;

    if ((code === 1000 || code === 1001) && !isAttemptingReconnect) {
        updateStatus('Signaling connection closed.', 'orange');
 resetConnection();
        await displayFriendList();
        return;
      }
      if (wsReconnectAttempts >= MAX_WS_RECONNECT_ATTEMPTS && isAttemptingReconnect) {
        updateStatus('Signaling connection lost. Please refresh the page.', 'red');
 resetConnection();
        await displayFriendList();
        isAttemptingReconnect = false;
        wsReconnectAttempts = 0;
        return;
 }
      if (!isAttemptingReconnect) {
        isAttemptingReconnect = true;
 wsReconnectAttempts = 0;
      }
      wsReconnectAttempts++;
      let delay = INITIAL_WS_RECONNECT_DELAY_MS * Math.pow(1.5, wsReconnectAttempts - 1);
 delay = Math.min(delay, MAX_WS_RECONNECT_DELAY_MS);
      updateStatus(`Signaling disconnected. Reconnecting in ${Math.round(delay/1000)}s (Attempt ${wsReconnectAttempts}/${MAX_WS_RECONNECT_ATTEMPTS})...`, 'orange');
      Object.keys(peers).forEach(peerUUID => closePeerConnection(peerUUID));
 Object.values(dataChannels).forEach(channel => { if (channel && channel.readyState !== 'closed') channel.close(); });
      dataChannels = {};
      setInteractionUiEnabled(false);
      currentAppState = AppState.CONNECTING;
 if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(async () => {
        await connectWebSocket();
      }, delay);
 };
  signalingSocket.onerror = (error) => {
    if (signalingSocket && (signalingSocket.readyState === WebSocket.OPEN || signalingSocket.readyState === WebSocket.CONNECTING)) {
        signalingSocket.close();
 } else if (!signalingSocket && !isAttemptingReconnect) {
    }
  };
 }
function sendSignalingMessage(message) {
  if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
    if (!message.payload) message.payload = {};
 if (!message.payload.uuid) message.payload.uuid = myDeviceId;
    signalingSocket.send(JSON.stringify(message));
  } else {
    updateStatus('Signaling connection not ready.', 'red');
 }
}
function startAutoConnectFriendsTimer() {
  if (autoConnectFriendsTimer) {
      clearInterval(autoConnectFriendsTimer);
  }
  autoConnectFriendsTimer = setInterval(attemptAutoConnectToFriends, AUTO_CONNECT_INTERVAL);
  attemptAutoConnectToFriends();
 }
function stopAutoConnectFriendsTimer() {
  if (autoConnectFriendsTimer) {
      clearInterval(autoConnectFriendsTimer);
      autoConnectFriendsTimer = null;
 }
}
async function attemptAutoConnectToFriends() {
  if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
      return;
 }
  if (currentAppState === AppState.CONNECTING && Object.keys(peers).some(id => peers[id]?.connectionState === 'connecting')) {
      return;
 }
  if (!dbPromise) {
      return;
 }
  try {
      const db = await dbPromise;
      const friends = await db.getAll('friends');
 if (friends.length === 0) return;
      for (const friend of friends) {
          if (friend.id === myDeviceId) continue;
 const isPeerConnectedOrConnecting = peers[friend.id] && (peers[friend.id].connectionState === 'connected' || peers[friend.id].connectionState === 'connecting' || peers[friend.id].connectionState === 'new');
 const isPeerUnderIndividualReconnect = peerReconnectInfo[friend.id] && peerReconnectInfo[friend.id].isReconnecting;
          if (onlineFriendsCache.has(friend.id) && !isPeerConnectedOrConnecting && !isPeerUnderIndividualReconnect) {
              updateStatus(`Auto-connecting to ${friend.id.substring(0,6)}...`, 'blue');
 await createOfferForPeer(friend.id, true);
          }
      }
  } catch (error) {
  }
}
async function startPeerReconnect(peerUUID) {
    if (!peers[peerUUID] || (peerReconnectInfo[peerUUID] && peerReconnectInfo[peerUUID].isReconnecting)) {
        return;
 }
    if (!await isFriend(peerUUID)) {
        closePeerConnection(peerUUID);
        return;
 }
    peerReconnectInfo[peerUUID] = {
        attempts: 0,
        timerId: null,
        isReconnecting: true
    };
 schedulePeerReconnectAttempt(peerUUID);
}
function schedulePeerReconnectAttempt(peerUUID) {
    const info = peerReconnectInfo[peerUUID];
 if (!info || !info.isReconnecting) {
        return;
    }
    info.attempts++;
 if (info.attempts > MAX_PEER_RECONNECT_ATTEMPTS) {
        updateStatus(`Failed to reconnect with ${peerUUID.substring(0,6)}.`, 'red');
 info.isReconnecting = false;
        closePeerConnection(peerUUID);
        return;
    }
    let delay = INITIAL_PEER_RECONNECT_DELAY_MS * Math.pow(1.5, info.attempts - 1);
 delay = Math.min(delay, 30000);
    updateStatus(`Reconnecting to ${peerUUID.substring(0,6)} (attempt ${info.attempts})...`, 'orange');
    if (info.timerId) clearTimeout(info.timerId);
 info.timerId = setTimeout(async () => {
        if (!info || !info.isReconnecting) return;
        if (peers[peerUUID] && peers[peerUUID].connectionState !== 'closed' && peers[peerUUID].connectionState !== 'failed') {
            closePeerConnection(peerUUID, true);
        }
        if (!peers[peerUUID]) {
            await createOfferForPeer(peerUUID, true);
        }
    }, delay);
 }
function stopPeerReconnect(peerUUID) {
    const info = peerReconnectInfo[peerUUID];
 if (info) {
        if (info.timerId) clearTimeout(info.timerId);
        info.isReconnecting = false;
        delete peerReconnectInfo[peerUUID];
 }
}
function setNegotiationTimeout(peerUUID) {
    if (peerNegotiationTimers[peerUUID]) {
        clearTimeout(peerNegotiationTimers[peerUUID]);
 }
    peerNegotiationTimers[peerUUID] = setTimeout(async () => {
        if (peers[peerUUID] && peers[peerUUID].connectionState !== 'connected') {
            updateStatus(`Connection attempt with ${peerUUID.substring(0,6)} timed out. Retrying...`, 'orange');
            const isCurrentlyFriend = await isFriend(peerUUID);
            closePeerConnection(peerUUID, true);
            if (isCurrentlyFriend && signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
         
 startPeerReconnect(peerUUID);
            } else {
            }
        }
        delete peerNegotiationTimers[peerUUID];
    }, NEGOTIATION_TIMEOUT_MS);
 }
function clearNegotiationTimeout(peerUUID) {
    if (peerNegotiationTimers[peerUUID]) {
        clearTimeout(peerNegotiationTimers[peerUUID]);
        delete peerNegotiationTimers[peerUUID];
 }
}
async function createPeerConnection(peerUUID) {
  if (peers[peerUUID]) {
    console.warn(`Closing existing PeerConnection for ${peerUUID}.`);
    closePeerConnection(peerUUID, true);
 }
  clearNegotiationTimeout(peerUUID);
  iceCandidateQueue[peerUUID] = [];
  try {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
 peer.onicecandidate = event => {
      if (event.candidate) {
        sendSignalingMessage({
            type: 'ice-candidate',
            payload: { target: peerUUID, candidate: event.candidate }
        });
 } else {
      }
    };
 peer.ondatachannel = event => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      setupDataChannelEvents(peerUUID, channel);
    };
 peer.ontrack = (event) => {
      handleRemoteTrack(peerUUID, event.track, event.streams[0]);
    };
 peer.onconnectionstatechange = async () => {
      switch (peer.connectionState) {
        case 'connected':
          updateStatus(`Connected with ${peerUUID.substring(0,6)}!`, 'green');
 clearNegotiationTimeout(peerUUID);
          if (peerReconnectInfo[peerUUID] && peerReconnectInfo[peerUUID].isReconnecting) {
            stopPeerReconnect(peerUUID);
 }
          const connectedPeers = Object.values(peers).filter(p => p?.connectionState === 'connected');
 if (connectedPeers.length > 0 && (messageInputElement && !messageInputElement.disabled)) {
          } else if (connectedPeers.length > 0) {
              setInteractionUiEnabled(true);
 currentAppState = AppState.CONNECTED;
          }
          break;
 case 'disconnected':
        case 'failed':
          updateStatus(`Connection with ${peerUUID.substring(0,6)} ${peer.connectionState}`, 'orange');
 clearNegotiationTimeout(peerUUID);
          if (await isFriend(peerUUID) && (!peerReconnectInfo[peerUUID] || !peerReconnectInfo[peerUUID].isReconnecting)) {
            if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
                 startPeerReconnect(peerUUID);
            } else {
                 closePeerConnection(peerUUID);
            }
          } else if (peerReconnectInfo[peerUUID] && peerReconnectInfo[peerUUID].isReconnecting) {
             // Reconnect logic already started, do nothing
          } else {
            closePeerConnection(peerUUID);
          }
          break;
        case 'closed':
          updateStatus(`Connection with ${peerUUID.substring(0,6)} closed.`, 'orange');
          stopPeerReconnect(peerUUID);
          // Check if any peer is still connected to re-enable UI if needed
          const openPeersCount = Object.values(peers).filter(p => p?.connectionState === 'connected').length;
          if (openPeersCount === 0 && currentAppState !== AppState.CONNECTING) {
            setInteractionUiEnabled(false);
            currentAppState = AppState.INITIAL;
          }
          break;
      }
    };
    peers[peerUUID] = peer;
    return peer;
  } catch (error) {
    updateStatus(`Error creating PeerConnection for ${peerUUID.substring(0,6)}: ${error.message}`, 'red');
    return null;
  }
}
function closePeerConnection(peerUUID, isReconnect = false) {
    clearNegotiationTimeout(peerUUID);
    const peer = peers[peerUUID];
    if (peer) {
        peer.onicecandidate = null;
        peer.ondatachannel = null;
        peer.ontrack = null;
        peer.onconnectionstatechange = null;
        peer.close();
        delete peers[peerUUID];
        delete iceCandidateQueue[peerUUID];
    }

    const channel = dataChannels[peerUUID];
    if (channel) {
        channel.onopen = null;
        channel.onmessage = null;
        channel.onclose = null;
        channel.onerror = null;
        if (channel.readyState !== 'closed') channel.close();
        delete dataChannels[peerUUID];
    }
    
    if (!isReconnect) {
        stopPeerReconnect(peerUUID);
    }

    if (remoteVideosContainer) {
        const videoElement = document.getElementById(`remoteVideo-${peerUUID}`);
        if (videoElement) videoElement.remove();
    }
    const connectedPeersCount = Object.values(peers).filter(p => p?.connectionState === 'connected').length;
    if (connectedPeersCount === 0 && currentAppState !== AppState.CONNECTING) {
        setInteractionUiEnabled(false);
        currentAppState = AppState.INITIAL;
        updateStatus(`Connection with ${peerUUID.substring(0,6)} closed. No active connections.`, 'orange');
    } else if (connectedPeersCount > 0) {
        updateStatus(`Connection with ${peerUUID.substring(0,6)} closed. Still connected to others.`, 'orange');
    }
}
function handleRemoteTrack(peerUUID, track, stream) {
    let videoElement = document.getElementById(`remoteVideo-${peerUUID}`);
    if (!videoElement) {
        videoElement = document.createElement('video');
        videoElement.id = `remoteVideo-${peerUUID}`;
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = false; // Remote video should not be muted by default
        videoElement.className = 'remote-video';
        if (remoteVideosContainer) remoteVideosContainer.appendChild(videoElement);
    }
    videoElement.srcObject = stream;
    // Set video/audio button state for remote tracks if needed
}
function setupDataChannelEvents(peerUUID, channel) {
    dataChannels[peerUUID] = channel;
    channel.onopen = () => {
        const openPeers = Object.entries(dataChannels)
            .filter(([uuid, dc]) => dc && dc.readyState === 'open')
            .map(([uuid, dc]) => uuid.substring(0,6));
        updateStatus(`Data channel with ${peerUUID.substring(0,6)} open. Ready with: ${openPeers.join(', ')}!`, 'green');
        setInteractionUiEnabled(true);
        currentAppState = AppState.CONNECTED;
    };
    channel.onmessage = (event) => {
        handleDataChannelMessage(event, peerUUID);
    };
    channel.onclose = () => {
        delete dataChannels[peerUUID];
        const openPeers = Object.entries(dataChannels)
            .filter(([uuid, dc]) => dc && dc.readyState === 'open')
            .map(([uuid, dc]) => uuid.substring(0,6));
        if (openPeers.length === 0) {
            updateStatus(`Data channel with ${peerUUID.substring(0,6)} closed. No active data channels.`, 'orange');
            setInteractionUiEnabled(false);
        } else {
            updateStatus(`Data channel with ${peerUUID.substring(0,6)} closed. Still ready with: ${openPeers.join(', ')}!`, 'orange');
        }
    };
    channel.onerror = (error) => {
        updateStatus(`Data channel error: ${error}`, 'red');
        closePeerConnection(peerUUID);
    };
}
async function createOfferForPeer(peerUUID, isReconnectAttempt = false) {
    currentAppState = AppState.CONNECTING;
    const peer = await createPeerConnection(peerUUID);
    if (!peer) return;

    const offerSdp = await createOfferAndSetLocal(peerUUID);
    if (offerSdp) {
        sendSignalingMessage({
            type: 'offer',
            payload: { target: peerUUID, sdp: offerSdp }
        });
        setNegotiationTimeout(peerUUID);
    } else {
        closePeerConnection(peerUUID);
    }
}
async function createOfferAndSetLocal(peerUUID) {
    const peer = peers[peerUUID];
    if (!peer) {
        return null;
    }
    try {
        const channel = peer.createDataChannel('cybernetcall-data');
        channel.binaryType = 'arraybuffer';
        setupDataChannelEvents(peerUUID, channel);

        // Add local stream tracks if available
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peer.addTrack(track, localStream);
            });
        }

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        return peer.localDescription.sdp;
    } catch (error) {
        updateStatus(`Error creating offer for ${peerUUID.substring(0,6)}: ${error.message}`, 'red');
        return null;
    }
}
async function handleOfferAndCreateAnswer(peerUUID, sdp) {
    if (!peers[peerUUID]) {
        await createPeerConnection(peerUUID);
    }
    const peer = peers[peerUUID];
    if (!peer) {
        return;
    }

    try {
        await peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdp }));
        processIceCandidateQueue(peerUUID); // Process any queued candidates after setting RD

        // Add local stream tracks if available
        if (localStream) {
            localStream.getTracks().forEach(track => {
                // Prevent duplicate tracks if already added during PC creation
                const senders = peer.getSenders();
                if (!senders.some(sender => sender.track === track)) {
                    peer.addTrack(track, localStream);
                }
            });
        }

        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendSignalingMessage({
            type: 'answer',
            payload: { target: peerUUID, sdp: peer.localDescription }
        });
        clearNegotiationTimeout(peerUUID);
    } catch (error) {
        updateStatus(`Error handling offer from ${peerUUID.substring(0,6)}: ${error.message}`, 'red');
        closePeerConnection(peerUUID);
    }
}
async function handleAnswer(peerUUID, sdp) {
    const peer = peers[peerUUID];
    if (!peer) {
        console.warn(`PeerConnection for ${peerUUID} not found when receiving answer.`);
        return;
    }
    try {
        await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sdp }));
        processIceCandidateQueue(peerUUID); // Process any queued candidates after setting RD
        clearNegotiationTimeout(peerUUID);
    } catch (error) {
        updateStatus(`Error handling answer from ${peerUUID.substring(0,6)}: ${error.message}`, 'red');
        closePeerConnection(peerUUID);
    }
}
async function handleIceCandidate(peerUUID, candidateData) {
    const peer = peers[peerUUID];
    if (!peer) {
        // Queue candidate if PC not created yet
        if (!iceCandidateQueue[peerUUID]) {
            iceCandidateQueue[peerUUID] = [];
        }
        iceCandidateQueue[peerUUID].push(candidateData);
        return;
    }
    if (candidateData) {
        if (peer.remoteDescription) {
            await peer.addIceCandidate(new RTCIceCandidate(candidateData));
        } else {
            if (!iceCandidateQueue[peerUUID]) {
                iceCandidateQueue[peerUUID] = [];
            }
            iceCandidateQueue[peerUUID].push(candidateData);
        }
    }
}
async function processIceCandidateQueue(peerUUID) {
    const peer = peers[peerUUID];
    if (peer && peer.remoteDescription && iceCandidateQueue[peerUUID]) {
        while (iceCandidateQueue[peerUUID].length > 0) {
            const candidate = iceCandidateQueue[peerUUID].shift();
            try {
                await peer.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                // Ignore errors related to duplicate or invalid candidates
            }
        }
    }
}
function resetConnection() {
    try {
        if (typeof Html5QrcodeScannerState !== 'undefined' && window.html5QrCodeScanner && window.html5QrCodeScanner.getState() === Html5QrcodeScannerState.SCANNING) {
            window.html5QrCodeScanner.stop().catch(e => console.warn("Error stopping scanner during reset:", e));
        } else if (window.html5QrCodeScanner) {
            window.html5QrCodeScanner.clear().catch(e => console.warn("Error clearing scanner during reset:", e));
        }
    } catch(e) { console.warn("Error accessing scanner state during reset:", e); }
    if (signalingSocket) {
        signalingSocket.onclose = null;
        signalingSocket.onerror = null;
        signalingSocket.onmessage = null;
        signalingSocket.onopen = null;
        if (signalingSocket.readyState === WebSocket.OPEN || signalingSocket.readyState === WebSocket.CONNECTING) {
            signalingSocket.close(1000);
        }
        signalingSocket = null;
    }
    Object.keys(peers).forEach(peerUUID => closePeerConnection(peerUUID));
    Object.values(dataChannels).forEach(channel => { if (channel && channel.readyState !== 'closed') channel.close(); });
    dataChannels = {};
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if(localVideoElement) localVideoElement.srcObject = null;
    currentAppState = AppState.INITIAL;
    setInteractionUiEnabled(false);
    stopAutoConnectFriendsTimer();
    wsReconnectAttempts = 0;
    isAttemptingReconnect = false;
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    pendingConnectionFriendId = null;
    currentCallerId = null;
    if (incomingCallModal) incomingCallModal.style.display = 'none';
    updateStatus(''); // Clear all status messages
}
function handleDataChannelMessage(event, senderUUID) {
    if (event.data instanceof ArrayBuffer) {
        if (lastReceivedFileChunkMeta[senderUUID]) {
            const meta = lastReceivedFileChunkMeta[senderUUID];
            processFileChunk(meta, event.data);
            lastReceivedFileChunkMeta[senderUUID] = null;
        }
    } else if (typeof event.data === 'string') {
        processTextMessage(event.data, senderUUID);
    } else {
        // Handle other data types if necessary
    }
}
async function processTextMessage(dataString, senderUUID) {
    try {
        const message = JSON.parse(dataString);
        switch (message.type) {
            case 'post':
                message.sender = message.sender || senderUUID;
                await savePost(message);
                displayPost(message, true);
                break;
            case 'direct-message':
                message.sender = message.sender || senderUUID;
                displayDirectMessage(message, false, senderUUID);
                break;
            case 'delete-post':
                const postElement = document.getElementById(`post-${message.postId}`);
                if (postElement) {
                    postElement.remove();
                }
                await deletePostFromDb(message.postId);
                break;
            case 'file-metadata':
                incomingFileInfo[message.fileId] = { name: message.name, size: message.size, type: message.fileType };
                receivedSize[message.fileId] = 0;
                if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Receiving ${message.name}... 0%`);
                break;
            case 'file-chunk':
                // This is a meta message, the next binary message is the chunk data
                lastReceivedFileChunkMeta[senderUUID] = message;
                break;
            default:
                console.warn('Unknown message type received:', message.type);
        }
    } catch (error) {
        console.error('Error processing incoming message:', error);
    }
}
async function processFileChunk(meta, chunkData) {
    const fileId = meta.fileId;
    const chunkIndex = meta.index;
    const isLast = meta.last;
    if (!incomingFileInfo[fileId]) {
        console.error('Chunk received for unknown file ID:', fileId);
        return;
    }

    try {
        const db = await dbPromise;
        if (!db) return;
        const tx = db.transaction('fileChunks', 'readwrite');
        const chunkBlob = new Blob([chunkData]); // Save as a Blob or ArrayBuffer
        await tx.store.put({ fileId: fileId, chunkIndex: chunkIndex, data: chunkBlob });
        await tx.done;

        receivedSize[fileId] += chunkData.byteLength;
        const totalSize = incomingFileInfo[fileId].size;
        const progress = Math.round((receivedSize[fileId] / totalSize) * 100);

        if (fileTransferStatusElement) {
            fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Receiving ${incomingFileInfo[fileId].name}... ${progress}%`);
        }

        if (isLast) {
            // All chunks received, assemble the file
            await assembleFile(fileId);
        }

    } catch (error) {
        console.error('Error saving file chunk:', error);
        if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Error receiving ${incomingFileInfo[fileId].name}`);
        await cleanupFileTransferData(fileId);
    }
}
async function cleanupFileTransferData(fileId, dbInstance = null, isSuccess = false) {
    delete incomingFileInfo[fileId];
    delete receivedSize[fileId];
    if (dbPromise) {
        try {
            const db = dbInstance || await dbPromise;
            const tx = db.transaction('fileChunks', 'readwrite');
            const index = tx.store.index('by_fileId');
            let cursor = await index.openCursor(IDBKeyRange.only(fileId));
            while (cursor) {
                await cursor.delete();
                cursor = await cursor.continue();
            }
            await tx.done;
            if (!isSuccess) {
                console.log(`Cleaned up data for failed transfer ${fileId}`);
            }
        } catch (error) {
            console.error('Error cleaning up file chunks:', error);
        }
    }
}
async function assembleFile(fileId) {
    const db = await dbPromise;
    if (!db) return;

    try {
        const tx = db.transaction('fileChunks', 'readonly');
        const index = tx.store.index('by_fileId');
        const allChunksForFileFromDb = await index.getAll(IDBKeyRange.only(fileId));
        await tx.done;

        const expectedChunkCount = Math.ceil(incomingFileInfo[fileId].size / CHUNK_SIZE);
        if (allChunksForFileFromDb.length !== expectedChunkCount) {
            console.error(`Expected ${expectedChunkCount} chunks, got ${allChunksForFileFromDb.length} from DB. Cannot assemble.`);
            if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Error receiving ${incomingFileInfo[fileId].name} (missing chunks from DB)`);
            await cleanupFileTransferData(fileId, db);
            return;
        }

        // Sort by chunkIndex to ensure correct order
        allChunksForFileFromDb.sort((a, b) => a.chunkIndex - b.chunkIndex);
        const orderedChunkData = allChunksForFileFromDb.map(c => c.data);
        const fileBlob = new Blob(orderedChunkData, { type: incomingFileInfo[fileId].type });

        // Create download link
        const downloadLink = document.createElement('a');
        downloadLink.href = URL.createObjectURL(fileBlob);
        downloadLink.download = incomingFileInfo[fileId].name;
        downloadLink.textContent = `Download ${incomingFileInfo[fileId].name}`;
        downloadLink.style.display = 'block';
        downloadLink.style.marginTop = '5px';

        if (fileTransferStatusElement) {
            fileTransferStatusElement.innerHTML = '';
            fileTransferStatusElement.appendChild(downloadLink);
        } else {
            messageAreaElement.appendChild(downloadLink);
        }

        await cleanupFileTransferData(fileId, db, true);

    } catch (error) {
        if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Error processing chunk for ${incomingFileInfo[fileId]?.name || 'unknown file'}`);
        await cleanupFileTransferData(fileId, db);
    }
}
function broadcastMessage(messageString) {
    let sentToAtLeastOne = false;
    const openChannels = Object.entries(dataChannels).filter(([uuid, dc]) => dc && dc.readyState === 'open');
    if (openChannels.length > 0) {
        openChannels.forEach(([uuid, dc]) => {
            try {
                dc.send(messageString);
                sentToAtLeastOne = true;
            } catch (error) {
                console.error(`Error sending message to ${uuid}:`, error);
            }
        });
    }
    return sentToAtLeastOne;
}
function broadcastBinaryData(data) {
    let sentToAtLeastOne = false;
    const openChannels = Object.entries(dataChannels).filter(([uuid, dc]) => dc && dc.readyState === 'open');
    if (openChannels.length > 0) {
        openChannels.forEach(([uuid, dc]) => {
            try {
                dc.send(data);
                sentToAtLeastOne = true;
            } catch (error) {
                console.error(`Error sending binary data to ${uuid}:`, error);
            }
        });
    }
    return sentToAtLeastOne;
}
function displayDirectMessage(message, isSelf = false, senderUUID) {
    if (!messageAreaElement) return;
    const div = document.createElement('div');
    div.className = isSelf ? 'message-self' : 'message-remote';
    let senderName = isSelf ? 'Me' : 'Unknown';

    if (isSelf) {
        senderName = 'Me';
    } else if (senderUUID) {
        senderName = `Peer (${senderUUID.substring(0, 6)})`;
    } else if (message.sender) {
        senderName = `Peer (${message.sender.substring(0, 6)})`;
    }

    const linkedContent = linkify(message.content);
    div.innerHTML = DOMPurify.sanitize(`<strong>${senderName}:</strong> ${linkedContent}`);
    messageAreaElement.appendChild(div);
    messageAreaElement.scrollTop = messageAreaElement.scrollHeight;
}
async function handleSendPost() {
    const input = postInputElement;
    const content = input?.value?.trim();
    if (content) {
        const post = {
            type: 'post',
            id: generateUUID(),
            content: content,
            sender: myDeviceId,
            timestamp: new Date().toISOString()
        };
        await savePost(post);
        displayPost(post, true);
        const postString = JSON.stringify(post);
        if (!broadcastMessage(postString)) {
            alert("Not connected. Post saved locally only.");
        }
        if(input) input.value = '';
    }
}
function handleSendFile() {
    if (!fileInputElement || !fileInputElement.files || fileInputElement.files.length === 0) {
        alert("Please select a file.");
        return;
    }
    const openChannels = Object.entries(dataChannels).filter(([uuid, dc]) => dc && dc.readyState === 'open');
    if (openChannels.length === 0) {
        console.warn("Send file clicked but no open data channels.");
        alert("Not connected to any peers to send the file.");
        return;
    }
    const file = fileInputElement.files[0];
    const snapshottedFileSize = file.size;
    const fileId = generateUUID();

    if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Sending ${file.name}... 0%`);
    if(sendFileButton) sendFileButton.disabled = true;

    // 1. Send metadata first
    const metadata = {
        type: 'file-metadata',
        fileId: fileId,
        name: file.name,
        size: snapshottedFileSize,
        fileType: file.type
    };
    broadcastMessage(JSON.stringify(metadata));

    let offset = 0;
    let chunkIndex = 0;

    const readSlice = (o) => {
        const slice = file.slice(offset, o + CHUNK_SIZE);
        fileReader = new FileReader();
        fileReader.onload = (event) => {
            sendFileChunk(event.target.result, file.name, snapshottedFileSize, fileId, chunkIndex, o);
        };
        fileReader.onerror = (error) => {
            console.error('Error reading file slice:', error);
            if (fileTransferStatusElement) fileTransferStatusElement.textContent = `Error reading file slice for ${file.name}`;
            if(sendFileButton) sendFileButton.disabled = false;
        };
        fileReader.readAsArrayBuffer(slice);
    };

    const sendFileChunk = async (chunkDataAsArrayBuffer, originalFileName, originalFileSizeInLogic, currentFileId, currentChunkIndex, currentOffset, retryCount = 0) => {
        try {
            const chunkMetaMessage = { 
                type: 'file-chunk', 
                fileId: currentFileId, 
                index: currentChunkIndex, 
                last: ((currentOffset + chunkDataAsArrayBuffer.byteLength) >= originalFileSizeInLogic) 
            };
            const metaString = JSON.stringify(chunkMetaMessage);
            if (!broadcastMessage(metaString)) {
                if (retryCount < 3) throw new Error(`Failed to send chunk meta ${currentChunkIndex} to any peer.`);
                else { console.error(`Failed to send chunk meta ${currentChunkIndex} after multiple retries.`); }
            }
            
            // Wait briefly to allow the meta message to be processed before the binary data arrives
            setTimeout(() => { 
                if (!broadcastBinaryData(chunkDataAsArrayBuffer)) {
                    if (retryCount < 3) throw new Error(`Failed to send chunk data ${currentChunkIndex} to any peer.`);
                    else { console.error(`Failed to send chunk data ${currentChunkIndex} after multiple retries.`); }
                }

                const newOffset = currentOffset + chunkDataAsArrayBuffer.byteLength;
                const progress = Math.round((newOffset / originalFileSizeInLogic) * 100);
                if (fileTransferStatusElement) fileTransferStatusElement.textContent = `Sending ${originalFileName}... ${progress}%`;

                if (newOffset < originalFileSizeInLogic) {
                    offset = newOffset;
                    chunkIndex++;
                    setTimeout(() => readSlice(newOffset), 0);
                } else {
                    if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Sent ${originalFileName}`);
                    if(fileInputElement) fileInputElement.value = '';
                    sendFileButton.disabled = false;
                }
            }, 10);
            
        } catch (error) {
            console.error(`File chunk send error (Chunk ${currentChunkIndex}): ${error.message}`);
            if (retryCount < 3) {
                // Retry logic: Wait a bit and try again
                setTimeout(() => sendFileChunk(chunkDataAsArrayBuffer, originalFileName, originalFileSizeInLogic, currentFileId, currentChunkIndex, currentOffset, retryCount + 1), 1000 * Math.pow(2, retryCount));
            } else {
                updateStatus(`Failed to send file chunk ${currentChunkIndex} for ${originalFileName} after multiple retries.`, 'red');
                if (fileTransferStatusElement) fileTransferStatusElement.innerHTML = DOMPurify.sanitize(`Failed to send ${originalFileName}`);
                if(sendFileButton) sendFileButton.disabled = false;
            }
        }
    };
    
    readSlice(offset);
}
async function toggleLocalMedia(video, audio) {
    if (!localStream) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: audio });
            localStream = stream;
            if(localVideoElement) localVideoElement.srcObject = stream;
            if(callButton) callButton.textContent = '📞 End';
            if(videoButton) videoButton.textContent = '🎥 End';
            
            // Add tracks to existing peer connections
            const renegotiationPromises = Object.entries(peers).map(async ([peerUUID, peer]) => {
                if (peer && peer.connectionState === 'connected') {
                    stream.getTracks().forEach(track => {
                        peer.addTrack(track, stream);
                    });
                    // Renegotiate to send new tracks
                    await createAndSendOfferForRenegotiation(peerUUID, peer);
                }
            });
            await Promise.all(renegotiationPromises);
        } catch (error) {
            updateStatus(`Media access failed: ${error.message}`, 'red');
            console.error('Media access failed:', error);
            if(callButton) callButton.textContent = '📞';
            if(videoButton) videoButton.textContent = '🎥';
        }
    } else {
        const tracksToRemove = localStream.getTracks();
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;

        // Remove tracks from existing peer connections
        const renegotiationPromises = Object.entries(peers).map(async ([peerUUID, peer]) => {
            if (peer) {
                peer.getSenders().forEach(sender => {
                    if (sender && sender.track && tracksToRemove.includes(sender.track)) {
                        try {
                            if (peer.removeTrack) {
                                peer.removeTrack(sender);
                            } else {
                                console.warn(`peer.removeTrack is not supported for ${peerUUID}.`);
                            }
                        } catch (e) {
                            console.error(`Error removing track from ${peerUUID}:`, e);
                        }
                    }
                });
                // Renegotiate to signal track removal
                await createAndSendOfferForRenegotiation(peerUUID, peer);
            }
        });
        await Promise.all(renegotiationPromises);
        if(localVideoElement) localVideoElement.srcObject = null;
        if(callButton) callButton.textContent = '📞';
        if(videoButton) videoButton.textContent = '🎥';
    }
}
async function createAndSendOfferForRenegotiation(peerUUID, peer) {
    if (!peer || peer.connectionState !== 'connected') {
        console.warn(`Cannot renegotiate with ${peerUUID}, connection not established.`);
        return;
    }
    try {
        // Create an offer to trigger renegotiation
        const offer = await peer.createOffer({ iceRestart: false, offerToReceiveAudio: true, offerToReceiveVideo: true });
        await peer.setLocalDescription(offer);
        sendSignalingMessage({
            type: 'offer',
            payload: { target: peerUUID, sdp: peer.localDescription }
        });
        setNegotiationTimeout(peerUUID);
    } catch (error) {
        console.error(`Error during renegotiation offer for ${peerUUID}:`, error);
    }
}
function toggleLocalVideo() {
    toggleLocalMedia(true, true);
}
function toggleLocalAudio() {
    toggleLocalMedia(false, true);
}
function handleScanButtonClick() {
    if (window.html5QrCodeScanner && typeof window.html5QrCodeScanner.getState === 'function' && window.html5QrCodeScanner.getState() !== 2 ) {
        startQrScanner();
    } else {
        console.warn("Scan button clicked but already scanning or scanner not ready.");
    }
}
function startQrScanner() {
    if (window.html5QrCodeScanner && window.html5QrCodeScanner.getState() === 2 ) { return; }
    if (!qrReaderElement) { console.warn("QR Reader element not available for start."); return; }
    if(startScanButton) startScanButton.disabled = true;
    qrReaderElement.style.display = 'block';

    if (typeof Html5Qrcode !== 'undefined') {
        try {
            if (window.html5QrCodeScanner && typeof window.html5QrCodeScanner.getState === 'function') {
                const state = window.html5QrCodeScanner.getState();
                if (state === 2 || state === 1 ) { 
                    window.html5QrCodeScanner.stop().catch(e => console.warn("Ignoring error stopping previous scanner:", e));
                }
            } else if (window.html5QrCodeScanner && typeof window.html5QrCodeScanner.clear === 'function') {
                window.html5QrCodeScanner.clear().catch(e => console.warn("Ignoring error clearing previous scanner:", e));
            }
        } catch (e) { console.warn("Error accessing previous scanner state:", e); }

        try {
            window.html5QrCodeScanner = new Html5Qrcode("qr-reader");
        } catch (e) {
            console.error("Error creating Html5Qrcode instance:", e);
            updateStatus(`QR Reader initialization error: ${e.message}`, 'red');
            if(qrReaderElement) qrReaderElement.style.display = 'none';
            if(startScanButton) startScanButton.disabled = false;
            return;
        }

        const qrCodeSuccessCallback = (decodedText, decodedResult) => {
            updateStatus('QR Scan successful. Processing...', 'blue');
            window.html5QrCodeScanner.stop().then(ignore => {
                if(qrReaderElement) qrReaderElement.style.display = 'none';
                if(startScanButton) startScanButton.disabled = false;
                processQrCodeData(decodedText);
            }).catch(err => {
                console.error("Error stopping scanner after success:", err);
                if(qrReaderElement) qrReaderElement.style.display = 'none';
                if(startScanButton) startScanButton.disabled = false;
                processQrCodeData(decodedText);
            });
        };

        const config = { fps: 10, qrbox: { width: 250, height: 250 } };
        window.html5QrCodeScanner.start({ facingMode: "environment" }, config, qrCodeSuccessCallback, (errorMessage) => {
            // console.log(`QR Code Scan error: ${errorMessage}`);
        }).catch(err => {
            console.error("QR Scan Start Error:", err);
            updateStatus(`QR Scan failed to start: ${err.message}`, 'red');
            if(qrReaderElement) qrReaderElement.style.display = 'none';
            if(startScanButton) startScanButton.disabled = false;
        });
    }
}
async function processQrCodeData(data) {
    try {
        const url = new URL(data);
        const friendId = url.searchParams.get('id');
        if (friendId && friendId !== myDeviceId) {
            updateStatus(`QR Code scanned: Found Friend ID ${friendId.substring(0,6)}...`, 'blue');
            if (await isFriend(friendId)) {
                updateStatus('Friend is already added. Starting call attempt.', 'blue');
                await createOfferForPeer(friendId);
            } else {
                updateStatus('New friend found. Adding friend...', 'blue');
                await addFriend(friendId);
                // After adding, attempt connection if signaling is ready
                if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
                    await createOfferForPeer(friendId);
                } else {
                    pendingConnectionFriendId = friendId;
                }
            }
        } else {
            throw new Error('QR code did not contain a valid friend link.');
        }
    } catch (error) {
        if (error instanceof TypeError) {
            updateStatus('QR data processing error: Not a valid URL format.', 'red');
        } else {
            updateStatus(`QR data processing error: ${error.message}`, 'red');
            alert(`QR data processing error: ${error.message}`);
        }
    }
}
function handleCallFriendClick(event) {
    const friendId = event.target.dataset.friendId;
    if (!friendId) return;
    if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
        alert("Not connected to signaling server. Please wait or refresh.");
        return;
    }
    if (currentAppState === AppState.CONNECTING || currentAppState === AppState.CONNECTED) {
        alert("Already in a call or connecting.");
        return;
    }

    updateStatus(`Calling ${friendId.substring(0, 6)}...`, 'blue');
    setInteractionUiEnabled(false);
    displayFriendList();
    sendSignalingMessage({ type: 'call-request', payload: { target: friendId } });
}
function handleIncomingCall(callerId) {
    if (currentAppState === AppState.CONNECTING || currentAppState === AppState.CONNECTED) {
        sendSignalingMessage({ type: 'call-busy', payload: { target: callerId } });
        return;
    }
    currentCallerId = callerId;
    if (callerIdElement) callerIdElement.textContent = callerId.substring(0, 8) + '...';
    if (incomingCallModal) incomingCallModal.style.display = 'block';
}
async function handleAcceptCall() {
    if (!currentCallerId) return;
    if (incomingCallModal) incomingCallModal.style.display = 'none';
    updateStatus(`Accepting call from ${currentCallerId.substring(0,6)}. Connecting...`, 'blue');
    sendSignalingMessage({ type: 'call-accepted', payload: { target: currentCallerId } });
    await createPeerConnection(currentCallerId);
    currentAppState = AppState.CONNECTING;
}
function handleRejectCall() {
    if (!currentCallerId) return;
    if (incomingCallModal) incomingCallModal.style.display = 'none';
    sendSignalingMessage({ type: 'call-rejected', payload: { target: currentCallerId } });
    updateStatus(`Rejected call from ${currentCallerId.substring(0,6)}.`, 'orange');
    currentCallerId = null;
    setInteractionUiEnabled(false); // Should re-enable only if no other active connection
}
function handleCallRejected(rejectedId) {
    if (currentCallerId === rejectedId) {
        if (incomingCallModal) incomingCallModal.style.display = 'none';
        currentCallerId = null;
    }
    updateStatus(`Call rejected by ${rejectedId.substring(0,6)}.`, 'orange');
    setInteractionUiEnabled(false); // Should re-enable only if no other active connection
}
function handleCallBusy(busyId) {
    if (currentCallerId === busyId) {
        if (incomingCallModal) incomingCallModal.style.display = 'none';
        currentCallerId = null;
    }
    updateStatus(`${busyId.substring(0,6)} is busy.`, 'orange');
    setInteractionUiEnabled(false); // Should re-enable only if no other active connection
}


// =========================================================================
// 🔔 Web Push Notification Functions 🔔
// =========================================================================

/**
 * 購読情報をDjangoサーバーにPOSTで送信する
 */
async function sendSubscriptionToServer(subscription) {
  // ⚠️ Django側で実装するエンドポイントと一致させること
  const url = '/api/save_push_subscription/'; 
  const csrfToken = document.querySelector('[name=csrfmiddlewaretoken]')?.value;

  if (!csrfToken) {
      console.error("CSRF token not found. Cannot save push subscription.");
      updateStatus("CSRF token not found. Push notifications disabled.", 'red');
      return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrfToken 
      },
      // 購読情報をJSON形式に変換
      body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: {
              p256dh: btoa(String.fromCharCode.apply(null, new Uint8Array(subscription.getKey('p256dh')))),
              auth: btoa(String.fromCharCode.apply(null, new Uint8Array(subscription.getKey('auth'))))
          }
      })
    });

    if (response.ok) {
      updateStatus('Push subscription saved on server.', 'green');
    } else {
      const errorData = await response.json().catch(() => ({ error: 'Unknown server error' }));
      updateStatus(`Failed to save subscription: ${response.status} - ${errorData.error || 'Server error'}`, 'red');
    }
  } catch (error) {
    updateStatus(`Network error while saving subscription: ${error.message}`, 'red');
  }
}

/**
 * Web Push通知を有効にし、購読情報をサーバーに送信する
 */
async function enablePushNotifications(registration) {
  if (Notification.permission === 'denied') {
    updateStatus('Push notification permission denied by user.', 'orange');
    return;
  }
  if (!('PushManager' in window) || VAPID_PUBLIC_KEY === 'PLACEHOLDER_VAPID_PUBLIC_KEY_MUST_BE_REPLACED') {
      updateStatus('Push notifications disabled (Browser unsupported or VAPID key missing).', 'red');
      return;
  }
  
  try {
    const existingSubscription = await registration.pushManager.getSubscription();

    if (existingSubscription) {
      console.log('Existing push subscription found. Sending update to server.');
      // 既存の購読がある場合でも、念のためサーバーに最新情報を送信
      await sendSubscriptionToServer(existingSubscription);
      return; 
    }

    // 新規購読を開始
    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey
    });

    updateStatus('Push subscription created successfully.', 'blue');
    await sendSubscriptionToServer(subscription);

  } catch (error) {
    if (Notification.permission === 'denied') {
      updateStatus('Push subscription failed: Permission denied by user.', 'red');
    } else {
      updateStatus(`Push subscription failed: ${error.name}: ${error.message}`, 'red');
    }
  }
}

// =========================================================================
// 🔔 End of Web Push Notification Functions 🔔
// =========================================================================


function setupEventListeners() {
    // ... (既存の setupEventListeners の定義)
    if(messageInputElement) messageInputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            handleSendMessage();
        }
    });
    if(sendMessageButton) sendMessageButton.addEventListener('click', handleSendMessage);
    if(postInputElement) postInputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            handleSendPost();
        }
    });
    if(sendPostButton) sendPostButton.addEventListener('click', handleSendPost);
    if(fileInputElement) fileInputElement.addEventListener('change', () => {
        if(fileInputElement.files.length > 0 && sendFileButton) sendFileButton.disabled = false;
    });
    if(sendFileButton) sendFileButton.addEventListener('click', handleSendFile);
    if(callButton) callButton.addEventListener('click', toggleLocalAudio);
    if(videoButton) videoButton.addEventListener('click', toggleLocalVideo);
    if(startScanButton) startScanButton.addEventListener('click', handleScanButtonClick);
    if(acceptCallButton) acceptCallButton.addEventListener('click', handleAcceptCall);
    if(rejectCallButton) rejectCallButton.addEventListener('click', handleRejectCall);
    // ... (他のイベントリスナー)
}
function handleSendMessage() {
    const input = messageInputElement;
    const content = input?.value?.trim();
    if (content) {
        const message = {
            type: 'direct-message',
            content: content,
            sender: myDeviceId,
            timestamp: new Date().toISOString()
        };
        displayDirectMessage(message, true);
        const messageString = JSON.stringify(message);
        if (!broadcastMessage(messageString)) {
             updateStatus("Not connected. Message not sent.", 'orange');
        }
        if(input) input.value = '';
    }
}
// ... (既存の DOMContentLoaded までのコード)
// ...
// ...

document.addEventListener('DOMContentLoaded', async () => {
    // 既存のDOM要素の取得
    qrElement = document.getElementById('qrCode');
    statusElement = document.getElementById('status');
    qrReaderElement = document.getElementById('qr-reader');
    qrResultsElement = document.getElementById('qr-results');
    localVideoElement = document.getElementById('localVideo');
    remoteVideoElement = document.getElementById('remoteVideo');
    messageAreaElement = document.getElementById('messageArea');
    postAreaElement = document.getElementById('postArea');
    
    // UI要素の取得
    incomingCallModal = document.getElementById('incomingCallModal');
    callerIdElement = document.getElementById('callerId');
    acceptCallButton = document.getElementById('acceptCallButton');
    rejectCallButton = document.getElementById('rejectCallButton');
    friendListElement = document.getElementById('friendList');
    messageInputElement = document.getElementById('messageInput');
    sendMessageButton = document.getElementById('sendMessage');
    postInputElement = document.getElementById('postInput');
    sendPostButton = document.getElementById('sendPost');
    fileInputElement = document.getElementById('fileInput');
    sendFileButton = document.getElementById('sendFile');
    fileTransferStatusElement = document.getElementById('file-transfer-status');
    callButton = document.getElementById('callButton');
    videoButton = document.getElementById('videoButton');
    startScanButton = document.getElementById('startScanButton');
    if (!remoteVideosContainer) { remoteVideosContainer = document.querySelector('.video-scroll-container');
    }

    // IDの初期化とQRコードの表示
    let storedDeviceId = localStorage.getItem('myDeviceId');
    if (!storedDeviceId) {
        storedDeviceId = generateUUID();
        localStorage.setItem('myDeviceId', storedDeviceId);
    }
    myDeviceId = storedDeviceId;
    updateStatus(`Your ID: ${myDeviceId.substring(0, 8)}...`, 'blue');
    const myUrl = `${window.location.origin}?id=${myDeviceId}`;
    if (qrElement) {
        new QRious({
            element: qrElement,
            value: myUrl,
            size: 200
        });
    }

    // イベントリスナーの設定
    setupEventListeners();

    // 既存のデータ表示
    await displayInitialPosts();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/cnc/service-worker.js')
        .then(registration => {
            registration.onupdatefound = () => {
                const installingWorker = registration.installing;
                if (installingWorker) {
                    installingWorker.onstatechange = () => {
                        if (installingWorker.state === 'installed') {
                            if (navigator.serviceWorker.controller) {
                                // New content available; ask user to refresh or force reload
                                const refreshing = false;
                                navigator.serviceWorker.addEventListener('controllerchange', () => {
                                    if (refreshing) return;
                                    window.location.reload();
                                    refreshing = true;
                                });
                            } else {
                                updateStatus('New version available. Please refresh soon to update.', 'blue');
                            }
                        }
                    };
                }
            };
            
            // 💡 プッシュ通知の購読処理をここに追加
            enablePushNotifications(registration); // 👈 この行を追加

        })
        .catch(error => {
          updateStatus(`Service Worker registration error: ${error.message}`, 'red');
        });
    } else {
      updateStatus('Offline features unavailable (Service Worker not supported)', 'orange');
    }
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
    await connectWebSocket();
    const urlParams = new URLSearchParams(window.location.search);
    const incomingFriendId = urlParams.get('id');
    if (incomingFriendId && incomingFriendId !== myDeviceId) {
        updateStatus(`Connecting from link with ${incomingFriendId.substring(0,6)}...`, 'blue');
        await addFriend(incomingFriendId);
        pendingConnectionFriendId = incomingFriendId;

      }

});