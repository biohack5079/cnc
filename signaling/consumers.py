import json
import logging
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from cnc.models import Notification

logger = logging.getLogger(__name__)

user_uuid_to_channel = {}

class SignalingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user_uuid = None
        await self.accept()
        logger.info(f"WebSocket connection accepted from {self.channel_name}")

    async def disconnect(self, close_code):
        logger.info(f"WebSocket connection closed for {self.channel_name} (UUID: {self.user_uuid}), code: {close_code}")
        if self.user_uuid and self.user_uuid in user_uuid_to_channel:
            if self.user_uuid in user_uuid_to_channel:
                del user_uuid_to_channel[self.user_uuid]
            logger.info(f"Removed user {self.user_uuid} from tracking.")

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
                target_channel_name = user_uuid_to_channel.get(target_uuid)

                if target_channel_name:
                    await self.forward_message_to_target(target_channel_name, message_type, payload)
                else:
                     logger.warning(f"Target user {target_uuid} not found or not connected.")
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
        if user_uuid in user_uuid_to_channel and user_uuid_to_channel[user_uuid] != self.channel_name:
            logger.warning(f"UUID {user_uuid} is already registered to a different channel. Overwriting.")

        self.user_uuid = user_uuid
        user_uuid_to_channel[self.user_uuid] = self.channel_name
        logger.info(f"Registered user {self.user_uuid} to channel {self.channel_name}")

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

        target_channel_name = user_uuid_to_channel.get(target_uuid)
        if target_channel_name:
            # 相手がオンラインなら、そのまま転送
            await self.forward_message_to_target(target_channel_name, 'call-request', payload)
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
        for uuid, channel_name in user_uuid_to_channel.items():
            if exclude_self and uuid == self.user_uuid:
                continue
            try:
                await self.channel_layer.send(
                    channel_name,
                    {
                        'type': 'signal_message',
                        'message': message
                    }
                )
            except Exception as e:
                 logger.error(f"Error broadcasting to {uuid} ({channel_name}): {e}")

    async def forward_message_to_target(self, target_channel_name, message_type, payload):
        """特定の宛先にメッセージを転送する"""
        logger.debug(f"Forwarding message type '{message_type}' from {self.user_uuid} to target channel {target_channel_name}")
        forward_message = {
            'type': message_type,
            'payload': payload,
            'from': self.user_uuid  # 送信者情報を付与
        }
        await self.channel_layer.send(
            target_channel_name,
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
