import json
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone
from datetime import timedelta
from cnc.models import UserProfile
from asgiref.sync import sync_to_async

class SignalingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user_id = None
        await self.accept()

    async def disconnect(self, close_code):
        if self.user_id:
            # グループからユーザーを削除
            await self.channel_layer.group_discard(
                "all_users",
                self.channel_name
            )
            # 他のユーザーに退出を通知
            await self.channel_layer.group_send(
                "all_users",
                {
                    "type": "user_left_event",
                    "payload": {"uuid": self.user_id}
                }
            )

    async def receive(self, text_data):
        message = json.loads(text_data)
        msg_type = message.get("type")
        payload = message.get("payload", {})

        if msg_type == "register":
            self.user_id = payload.get("uuid")
            if not self.user_id:
                return

            # ユーザープロファイルの取得または作成
            user_profile, is_subscribed = await self.get_or_create_user_profile(self.user_id)

            # グループに参加
            # 1. 全員向けグループ
            await self.channel_layer.group_add("all_users", self.channel_name) 
            # 2. 自分専用のグループ
            await self.channel_layer.group_add(self.user_id, self.channel_name)

            # 登録完了と課金状態をクライアントに通知
            await self.send(text_data=json.dumps({
                "type": "registered",
                "payload": {
                    "uuid": self.user_id,
                    "is_subscribed": is_subscribed,
                    "is_trial": user_profile.subscription_status == "incomplete" and (timezone.now() - user_profile.created_at < timedelta(days=30)),
                    "trial_ends_at": (user_profile.created_at + timedelta(days=30)).isoformat() if user_profile else None
                }
            }))

            # 他のユーザーに接続を通知
            await self.channel_layer.group_send(
                "all_users",
                {
                    "type": "user_joined_event",
                    "payload": {"uuid": self.user_id}
                }
            )
        else:
            # 他のメッセージタイプ（offer, answer, ice-candidateなど）を転送
            target_uuid = payload.get("target")
            if target_uuid:
                # メッセージに送信者IDを追加
                payload["from"] = self.user_id
                # ターゲットユーザーの専用グループにメッセージを送信
                await self.channel_layer.group_send(
                    target_uuid,
                    {
                        "type": "forward_signaling_message",
                        "message": message,
                    }
                )

    @sync_to_async
    def get_or_create_user_profile(self, user_id):
        """DBからユーザープロファイルを取得または作成し、課金状態を返す"""
        profile, created = UserProfile.objects.get_or_create(id=user_id)

        # 課金状態の判定
        is_subscribed = False
        # 1. Stripeでアクティブなサブスクリプションがあるか
        if profile.subscription_status in ['active', 'trialing']:
            is_subscribed = True
        # 2. トライアル期間中か (作成から30日以内)
        elif timezone.now() - profile.created_at < timedelta(days=30):
            is_subscribed = True

        return profile, is_subscribed

    # --- イベントハンドラ ---
    async def user_joined_event(self, event):
        """グループ内の他ユーザーに 'user_joined' を送信"""
        if self.user_id != event["payload"]["uuid"]:
            await self.send(text_data=json.dumps({"type": "user_joined", "uuid": event["payload"]["uuid"]}))

    async def user_left_event(self, event):
        """グループ内の他ユーザーに 'user_left' を送信"""
        if self.user_id != event["payload"]["uuid"]:
            await self.send(text_data=json.dumps({"type": "user_left", "uuid": event["payload"]["uuid"]}))

    async def forward_signaling_message(self, event):
        """受信したメッセージをそのままクライアントに転送"""
        message = event["message"]
        # メッセージに送信者情報を付与して転送
        message['from'] = event['message'].get('payload', {}).get('from')
        await self.send(text_data=json.dumps(message))