import os 
from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from channels.auth import AuthMiddlewareStack
# import cnc.routing # cnc から signaling に変更
import signaling.routing # signaling アプリのルーティングをインポート

# os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings') # mysite から cnc-pwa に変更
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'cnc-pwa.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            signaling.routing.websocket_urlpatterns # signaling アプリのルーティングを使用
        )
    ),
})
