from django.contrib import admin
from .models import UserProfile, PushSubscription, StripeCustomer

@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ('id', 'subscription_status', 'created_at')
    search_fields = ('id', 'stripe_customer_id', 'stripe_subscription_id')
    list_filter = ('subscription_status', 'created_at')
    readonly_fields = ('id', 'created_at')

@admin.register(PushSubscription)
class PushSubscriptionAdmin(admin.ModelAdmin):
    list_display = ('user_uuid', 'endpoint')
    search_fields = ('user_uuid',)

@admin.register(StripeCustomer)
class StripeCustomerAdmin(admin.ModelAdmin):
    list_display = ('user_uuid', 'stripe_customer_id')
    search_fields = ('user_uuid', 'stripe_customer_id')
