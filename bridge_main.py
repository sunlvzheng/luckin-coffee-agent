"""瑞幸点单 Agent · 桥接服务（单文件 exe 入口）。

单独放一个入口文件，是为了让 PyInstaller 从一个明确的地方启动：

    pyinstaller --onefile --add-data "docs;docs" bridge_main.py

双击生成的 exe 就能起服务，它会：
    1. 做一遍自检（CLI 装没装、登录没有、跨域放开了没）
    2. 自动打开浏览器到访问地址
    3. 顺便把网页也托管在同一个地址上（读打包进去的 docs/）

配置方式：把 .env 放在 exe 旁边即可（和项目根目录用法完全一致）。
"""

from coffee_agent.server import main

if __name__ == "__main__":
    main()
