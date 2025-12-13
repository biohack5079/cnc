from django.contrib import admin
from django.urls import path
from cnc import views
from django.http import JsonResponse
from django.conf import settings

def get_stripe_public_key(request):
    return JsonResponse({'publicKey': settings.STRIPE_PUBLISHABLE_KEY})

urlpatterns = [
    path("api/get_vapid_public_key/", views.VapidPublicKeyView.as_view(), name="get_vapid_public_key"),
    path("api/save_push_subscription/", views.SavePushSubscriptionView.as_view(), name="save_push_subscription"),
    path('api/stripe/public-key/', get_stripe_public_key, name='get_stripe_public_key'),
    path("api/create-checkout-session/", views.CreateCheckoutSessionView.as_view(), name="create_checkout_session"),
    path("api/stripe-webhook/", views.StripeWebhookView.as_view(), name="stripe_webhook"),
]
