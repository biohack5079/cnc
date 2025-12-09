from django.contrib import admin
from django.urls import path
from cnc import views

urlpatterns = [
    path("", views.IndexView.as_view(), name="cnc/index.html"),
    path("api/get_vapid_public_key/", views.VapidPublicKeyView.as_view(), name="get_vapid_public_key"),
    path("api/save_push_subscription/", views.SavePushSubscriptionView.as_view(), name="save_push_subscription"),
]
