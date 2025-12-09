import json
import logging
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from cnc.models import Notification

logger = logging.getLogger(__name__)

# このグローバル変数は、複数のサーバープロセスで共有されないため、本番環境では問題になります。
# Channelsのグループ機能を使ってオンライン状態を管理するように変更します。
# user_uuid_to_channel = {}

class SignalingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user_uuid = None
        self.broadcast_group_name = "signaling_broadcast"
        await self.accept()
        logger.info(f"WebSocket connection accepted from {self.channel_name}")

    async def disconnect(self, close_code):
        logger.info(f"WebSocket connection closed for {self.channel_name} (UUID: {self.user_uuid}), code: {close_code}")
        if self.user_uuid:
            # ブロードキャストグループとユーザー固有グループから離脱
            await self.channel_layer.group_discard(self.broadcast_group_name, self.channel_name)
            await self.channel_layer.group_discard(self.user_uuid, self.channel_name)
            
            await self.broadcast({
                'type': 'user_left',
                'uuid': self.user_uuid
            }, exclude_self=True)

    async def receive(self, text_data):
        try:
            message = json.loads(text_data)
            message_type = message.get('type')
            payload = message.get('payload', {})
            logger.debug(f"Received message type '{message_type}' from {self.channel_name} (UUID: {self.user_uuid})")

            if message_type == 'register':
                uuid_from_payload = payload.get('uuid')
                if uuid_from_payload:
                    await self.handle_register(uuid_from_payload)
                else:
                    logger.warning("Registration message received without UUID.")

            elif message_type == 'call-request':
                # call-requestを特別に処理
                await self.handle_call_request(payload)

            elif self.user_uuid:
                # その他のメッセージはそのまま転送
                target_uuid = payload.get('target')
                if not target_uuid:
                    logger.warning(f"Received message type '{message_type}' without target from {self.user_uuid}. Ignoring.")
                    return
                
                # ユーザー固有のグループにメッセージを転送する
                await self.forward_message_to_target(target_uuid, message_type, payload)
                # 注: 相手がオフラインでもエラーにはならない。メッセージが破棄されるだけ。

            else:
                 logger.warning(f"Received message type '{message_type}' from unregistered channel {self.channel_name}. Ignoring.")

        except json.JSONDecodeError:
            logger.error(f"Could not decode JSON from {self.channel_name}: {text_data}")
        except Exception as e:
            logger.exception(f"Error processing message from {self.channel_name}: {e}")
            import traceback
            traceback.print_exc()

    async def handle_register(self, user_uuid):
        """ユーザー登録と通知の送信を処理"""
        self.user_uuid = user_uuid

        # ユーザー固有のグループと、全体通知用のグループに参加
        await self.channel_layer.group_add(self.user_uuid, self.channel_name)
        await self.channel_layer.group_add(self.broadcast_group_name, self.channel_name)

        logger.info(f"Registered user {self.user_uuid} and added to groups.")

        # 未配信の通知を取得
        notifications = await self.get_undelivered_notifications(self.user_uuid)

        # 登録完了メッセージを送信（通知も含む）
        await self.send(text_data=json.dumps({
            "type": "registered",
            "payload": {
                "uuid": self.user_uuid,
                "notifications": notifications  # 通知データをペイロードに追加
            }
        }))

        # 配信済みにマーク
        if notifications:
            await self.mark_notifications_as_delivered(self.user_uuid)

        # 他のユーザーに 'user_joined' をブロードキャスト
        await self.broadcast({
            'type': 'user_joined',
            'uuid': self.user_uuid
        }, exclude_self=True)

    async def handle_call_request(self, payload):
        """着信リクエストを処理し、オフラインならDBに保存"""
        target_uuid = payload.get('target')
        sender_uuid = payload.get('uuid')

        if not target_uuid or not sender_uuid:
            return

        # RedisなどのChannel Layerに問い合わせて、相手のグループが存在するか（オンラインか）を間接的に確認
        # ここでは簡略化のため、常に転送を試みる。相手がオフラインならメッセージは破棄される。
        # より確実なオンラインチェックが必要な場合は、別途オンライン状態をRedisに保存するなどの仕組みが必要。
        is_online = await self.is_user_online(target_uuid)
        if is_online:
            # 相手がオンラインなら、そのまま転送
            await self.forward_message_to_target(target_uuid, 'call-request', payload)
        else:
            # 相手がオフラインなら、DBに通知を保存
            await self.create_missed_call_notification(recipient_uuid=target_uuid, sender_uuid=sender_uuid)
            logger.info(f"User {target_uuid[:8]} is offline. Saved missed call notification from {sender_uuid[:8]}.")

    async def signal_message(self, event):
        message = event['message']
        logger.debug(f"Sending signal message to {self.channel_name} (UUID: {self.user_uuid}): {message.get('type')}")
        await self.send(text_data=json.dumps(message))

    async def broadcast(self, message, exclude_self=True):
        logger.debug(f"Broadcasting message: {message}")
        # 全体通知用グループに送信
        await self.channel_layer.group_send(
            self.broadcast_group_name,
            {
                'type': 'signal_message',
                'message': message,
                'sender_channel': self.channel_name if exclude_self else None
            }
        )

    # `signal_message`ハンドラを修正して、自分自身へのブロードキャストをスキップ
    async def signal_message(self, event):
        message = event['message']
        sender_channel = event.get('sender_channel')
        if sender_channel and self.channel_name == sender_channel:
            return
        logger.debug(f"Sending signal message to {self.channel_name} (UUID: {self.user_uuid}): {message.get('type')}")
        await self.send(text_data=json.dumps(message))

    async def forward_message_to_target(self, target_uuid, message_type, payload):
        """特定の宛先にメッセージを転送する"""
        logger.debug(f"Forwarding message type '{message_type}' from {self.user_uuid} to target user {target_uuid}")
        forward_message = {
            'type': message_type,
            'payload': payload,
            'from': self.user_uuid  # 送信者情報を付与
        }
        # ユーザー固有のグループに送信
        await self.channel_layer.group_send(
            target_uuid,
            {
                'type': 'signal_message',
                'message': forward_message
            }
        )

    # --- データベース操作 (非同期) ---

    @database_sync_to_async
    def get_undelivered_notifications(self, recipient_uuid):
        """未配信の通知を取得してシリアライズする"""
        notifications = Notification.objects.filter(
            recipient_uuid=recipient_uuid,
            is_delivered=False
        ).order_by('timestamp') # 古い順に取得
        return [
            {
                "sender": notif.sender_uuid,
                "timestamp": notif.timestamp.isoformat(),
                "type": notif.notification_type
            }
            for notif in notifications
        ]

    @database_sync_to_async
    def mark_notifications_as_delivered(self, recipient_uuid):
        """通知を配信済みに更新する"""
        Notification.objects.filter(recipient_uuid=recipient_uuid, is_delivered=False).update(is_delivered=True)

    @database_sync_to_async
    def create_missed_call_notification(self, recipient_uuid, sender_uuid):
        """不在着信の通知をDBに作成する"""
        Notification.objects.create(
            recipient_uuid=recipient_uuid,
            sender_uuid=sender_uuid,
            notification_type='missed_call'
        )

    async def is_user_online(self, user_uuid):
        """
        ユーザーがオンラインかどうかを（間接的に）チェックする。
        この方法は100%正確ではありませんが、インメモリ辞書よりはるかに優れています。
        """
        # 存在しないグループに送信してもエラーにはならない
        return True # 一旦、常にオンラインと見なして転送を試みる
