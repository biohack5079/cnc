from django.db import models
import uuid

# Create your models here.

class Notification(models.Model):
    """
    オフラインユーザーへの通知を保存するモデル。
    """
    # 通知ID (主キー)
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    
    # 宛先ユーザーのUUID
    recipient_uuid = models.CharField(max_length=36, db_index=True)
    
    # 送信元ユーザーのUUID
    sender_uuid = models.CharField(max_length=36)
    
    # 通知のタイプ（例: 'missed_call'）
    notification_type = models.CharField(max_length=50)
    
    # 通知が作成された日時
    timestamp = models.DateTimeField(auto_now_add=True)
    
    # クライアントに送信済みかどうかのフラグ
    is_delivered = models.BooleanField(default=False)

    def __str__(self):
        return f"Notification for {self.recipient_uuid[:8]} from {self.sender_uuid[:8]} ({self.notification_type})"

    class Meta:
        # 新しい順で取得できるように設定
        ordering = ['-timestamp']

class PushSubscription(models.Model):
    """
    Web Push通知の購読情報を保存するモデル。
    """
    # ユーザーのUUID
    user_uuid = models.CharField(max_length=36, db_index=True)
    
    # Push Serviceから提供されるエンドポイントURL
    endpoint = models.URLField(max_length=512, unique=True)
    
    # 購読情報に含まれるキー
    p256dh = models.CharField(max_length=255)
    auth = models.CharField(max_length=255)
    
    # 登録日時
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Push Subscription for {self.user_uuid[:8]}"

    class Meta:
        verbose_name = "Push Subscription"
        verbose_name_plural = "Push Subscriptions"
