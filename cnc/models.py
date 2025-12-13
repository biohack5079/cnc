from django.db import models
import uuid

class UserProfile(models.Model):
    """ユーザー情報を格納するモデル"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, help_text="ユーザーの一意なID (myDeviceId)")
    created_at = models.DateTimeField(auto_now_add=True, help_text="ユーザーが最初に登録された日時")
    stripe_customer_id = models.CharField(max_length=255, blank=True, null=True, help_text="Stripeの顧客ID")
    stripe_subscription_id = models.CharField(max_length=255, blank=True, null=True, help_text="StripeのサブスクリプションID")
    subscription_status = models.CharField(max_length=50, default="incomplete", help_text="Stripeのサブスクリプションステータス")

    def __str__(self):
        return f"{self.id} - Status: {self.subscription_status}"