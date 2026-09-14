"""冒烟测试：不依赖大模型，直接验证 luckin CLI 链路是否通。

    python -m scripts.smoke                 # 用 .env 里的定位
    python -m scripts.smoke 39.9042 116.4074 拿铁 "生椰拿铁 冰 少少甜 大杯"

只执行「查门店 / 搜商品 / 试算订单」这类只读操作，绝不会下单。
和桥接服务 /api/invoke 走同一个分发函数，测的就是线上路径。
"""

from __future__ import annotations

import asyncio
import sys

from coffee_agent.luckin_cli import LuckinCLI, LuckinError
from coffee_agent.server import COMMANDS
from coffee_agent.settings import load_settings

# Windows 控制台默认 GBK，这里强制按 UTF-8 输出，避免中文/符号报错
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]


async def invoke(cli: LuckinCLI, command: str, args: dict):
    return await COMMANDS[command](cli, args)


async def main() -> int:
    settings = load_settings()
    latitude = float(sys.argv[1]) if len(sys.argv) > 1 else settings.lat
    longitude = float(sys.argv[2]) if len(sys.argv) > 2 else settings.lng
    keyword = sys.argv[3] if len(sys.argv) > 3 else None
    query = sys.argv[4] if len(sys.argv) > 4 else "生椰拿铁 冰 少少甜 大杯"

    print("=" * 70)
    print(f"CLI        : {settings.exe}")
    print(f"服务端模型 : {settings.model if settings.llm_ready else '未配置'} ({settings.model_source})")
    print(f"定位       : {latitude}, {longitude}")
    print("=" * 70)

    if latitude is None or longitude is None:
        print("❌ 没有定位：请传参 `python -m scripts.smoke 39.9042 116.4074` 或在 .env 里配置")
        return 1

    cli = LuckinCLI(settings.exe, settings.token, settings.timeout)

    print(f"\n[1/4] 查询 {latitude},{longitude} 附近门店{f'（关键词：{keyword}）' if keyword else ''} …")
    stores = await invoke(cli, "stores", {"latitude": latitude, "longitude": longitude, "keyword": keyword})
    if not stores:
        print("❌ 没有查到门店")
        return 1
    for store in stores[:8]:
        print(f"   #{store['deptId']:<8} {store['deptName']:<20} {store['distance']:<10} {store.get('workStatus', '')}")

    dept_id = stores[0]["deptId"]

    print(f"\n[2/4] 在门店 {dept_id} 搜索「{query}」…")
    products = await invoke(cli, "searchProducts", {"deptId": dept_id, "query": query})
    if not products:
        print("❌ 没有搜到商品")
        return 1
    for product in products[:4]:
        spec = "/".join(
            (sub.get("attributeName") or "")
            for group in product.get("productAttrs") or []
            for sub in group.get("productSubAttrs") or []
        )
        print(f"   #{product['productId']:<6} {product['productName']:<22} ¥{product.get('estimatePrice')}  {spec}")
        print(f"          skuCode = {product['skuCode']}")

    first = products[0]
    items = [{"product_id": first["productId"], "sku_code": first["skuCode"], "amount": 1}]

    print("\n[3/4] 试算订单（只读，不会下单）…")
    preview = await invoke(cli, "previewOrder", {"deptId": dept_id, "items": items})
    if not preview:
        print("❌ 试算失败：返回为空（常见原因：skuCode 与门店不匹配）")
        return 1
    shop = preview.get("shopInfo") or {}
    print(f"   门店：{shop.get('deptName')}  {shop.get('address')}")
    print(
        f"   面价合计：¥{preview.get('totalInitialPrice')}   "
        f"优惠：¥{preview.get('privilegeMoney')}   实付：¥{preview.get('discountPrice')}"
    )
    for line in preview.get("productInfoList") or []:
        print(f"   {line.get('amount')}×{line.get('name')}  {line.get('additionDesc')}")

    print("\n[4/4] 参数校验：故意传错 skuCode，应当被拒绝 …")
    try:
        await invoke(
            cli,
            "previewOrder",
            {"deptId": dept_id, "items": [{**items[0], "sku_code": "SP0000-00000"}]},
        )
        print("   ⚠️ 未被拒绝（真实下单前请留意）")
    except LuckinError as exc:
        print(f"   ✅ 已按预期拒绝：{str(exc)[:100]}")

    print("\n✅ 只读链路正常（未产生任何订单）")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except LuckinError as exc:
        print(f"\n❌ CLI 调用失败：{exc}")
        raise SystemExit(1) from exc
