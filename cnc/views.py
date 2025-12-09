import json
from django.http import JsonResponse, HttpResponseBadRequest
from django.views.generic import View
from django.shortcuts import render
from django.conf import settings
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from .models import PushSubscription


class IndexView(View):
    def get(self, request, *args, **kwargs):
        return render(request, "cnc/index.html")


class VapidPublicKeyView(View):
    """VAPID公開鍵をクライアントに提供するビュー"""
    def get(self, request, *args, **kwargs):
        # settings.pyから公開鍵を読み込む
        public_key = settings.VAPID_PUBLIC_KEY
        # Base64エンコードされた公開鍵を返す
        return JsonResponse({'publicKey': public_key})


@method_decorator(csrf_exempt, name='dispatch')
class SavePushSubscriptionView(View):
    """クライアントからのPush購読情報を保存するビュー"""
    def post(self, request, *args, **kwargs):
        try:
            data = json.loads(request.body)
            subscription_data = data.get('subscription')
            user_id = data.get('user_id')

            if not subscription_data or not user_id:
                return HttpResponseBadRequest("Missing subscription data or user_id.")

            endpoint = subscription_data.get('endpoint')
            p256dh = subscription_data.get('keys', {}).get('p256dh')
            auth = subscription_data.get('keys', {}).get('auth')

            # 同じendpointがあれば更新、なければ新規作成する
            PushSubscription.objects.update_or_create(
                endpoint=endpoint,
                defaults={'user_uuid': user_id, 'p256dh': p256dh, 'auth': auth}
            )
            return JsonResponse({'status': 'ok'})
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            return HttpResponseBadRequest(f"Invalid request: {e}")
