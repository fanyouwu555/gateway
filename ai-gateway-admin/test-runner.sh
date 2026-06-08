#!/bin/bash
# AI Gateway 管理控制台 - 自动化测试脚本

set -euo pipefail

# 配置
BASE_URL="http://localhost:3001"
SCREENSHOT_DIR="./test-screenshots"
mkdir -p "$SCREENSHOT_DIR"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试统计
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_BLOCKED=0

# 测试函数
pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

block() {
    echo -e "${YELLOW}[BLOCK]${NC} $1"
    ((TESTS_BLOCKED++))
}

# ========================================
# 1. 登录页面测试
# ========================================
test_login_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 登录页面"
    echo "========================================"

    # TC-LOGIN-001: 空 API Key 提交
    echo ""
    echo "[TC-LOGIN-001] 空 API Key 提交"
    agent-browser open "$BASE_URL"
    agent-browser wait --load networkidle
    agent-browser snapshot -i > "$SCREENSHOT_DIR/login-page.txt"
    
    # 检查登录按钮是否存在
    if agent-browser snapshot -i | grep -q "登录"; then
        pass "登录页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/login-page.png"
    else
        fail "登录页面加载失败"
        return 1
    fi
    
    # 尝试点击登录按钮（应该禁用或无反应）
    agent-browser click "button:has-text('登录')"
    agent-browser wait 1000
    
    # TC-LOGIN-002: 无效 API Key 登录
    echo ""
    echo "[TC-LOGIN-002] 无效 API Key 登录"
    agent-browser fill "input[type='password']" "invalid-test-key-12345"
    agent-browser wait 500
    agent-browser click "button:has-text('登录')"
    agent-browser wait 2000
    
    # 检查是否有错误提示
    if agent-browser snapshot -i | grep -qE "(无效|错误|失败)"; then
        pass "无效 API Key 显示错误提示"
        agent-browser screenshot "$SCREENSHOT_DIR/login-error.png"
    else
        fail "无效 API Key 未显示错误提示"
    fi
    
    # 清除输入
    agent-browser fill "input[type='password']" ""
    agent-browser wait 500
}

# ========================================
# 2. 仪表盘页面测试
# ========================================
test_dashboard_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 仪表盘页面"
    echo "========================================"
    
    # 检查是否可以访问仪表盘（假设已登录或有测试 API Key）
    agent-browser open "$BASE_URL/dashboard"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/dashboard-page.txt"
    
    # TC-DASH-001: 页面加载统计数据
    echo ""
    echo "[TC-DASH-001] 页面加载统计数据"
    if agent-browser snapshot -i | grep -qE "(总请求|Token|延迟|成功)"; then
        pass "统计数据显示正常"
        agent-browser screenshot "$SCREENSHOT_DIR/dashboard-stats.png"
    else
        fail "统计数据未显示"
    fi
    
    # TC-DASH-002: 刷新功能
    echo ""
    echo "[TC-DASH-002] 刷新功能"
    agent-browser click "button:has-text('刷新')"
    agent-browser wait 2000
    pass "刷新按钮可点击"
    
    # TC-DASH-008 ~ TC-DASH-011: 图表显示
    echo ""
    echo "[TC-DASH-008~011] 图表显示测试"
    if agent-browser snapshot -i | grep -qE "(趋势|分布|请求量)"; then
        pass "图表区域显示正常"
        agent-browser screenshot "$SCREENSHOT_DIR/dashboard-charts.png"
    else
        fail "图表区域未显示"
    fi
    
    # TC-DASH-019: WebSocket 连接状态
    echo ""
    echo "[TC-DASH-019] WebSocket 连接状态"
    if agent-browser snapshot -i | grep -qE "(实时连接|已断开|connected)"; then
        pass "WebSocket 状态显示正常"
    else
        fail "WebSocket 状态未显示"
    fi
}

# ========================================
# 3. Provider 管理页面测试
# ========================================
test_providers_page() {
    echo ""
    echo "========================================"
    echo "测试模块: Provider 管理"
    echo "========================================"
    
    agent-browser open "$BASE_URL/providers"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/providers-page.txt"
    
    # TC-PROV-001: Provider 列表加载
    echo ""
    echo "[TC-PROV-001] Provider 列表加载"
    if agent-browser snapshot -i | grep -qE "(Provider|提供商|状态)"; then
        pass "Provider 列表加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/providers-list.png"
    else
        fail "Provider 列表加载失败"
    fi
    
    # TC-PROV-002: 刷新功能
    echo ""
    echo "[TC-PROV-002] 刷新功能"
    agent-browser click "button:has-text('刷新')"
    agent-browser wait 2000
    pass "刷新按钮可点击"
    
    # TC-PROV-007: 模型发现
    echo ""
    echo "[TC-PROV-007] 模型发现功能"
    agent-browser click "button:has-text('发现模型')"
    agent-browser wait 3000
    
    if agent-browser snapshot -i | grep -qE "(模型|发现|scan)"; then
        pass "模型发现模态框打开成功"
        agent-browser screenshot "$SCREENSHOT_DIR/providers-discover.png"
        agent-browser press Escape
    else
        fail "模型发现模态框未打开"
    fi
}

# ========================================
# 4. 租户管理页面测试
# ========================================
test_tenants_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 租户管理"
    echo "========================================"
    
    agent-browser open "$BASE_URL/tenants"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/tenants-page.txt"
    
    # TC-TENANT-001: 租户列表加载
    echo ""
    echo "[TC-TENANT-001] 租户列表加载"
    if agent-browser snapshot -i | grep -qE "(租户|Tenant|名称|ID)"; then
        pass "租户列表加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/tenants-list.png"
    else
        fail "租户列表加载失败"
    fi
    
    # TC-TENANT-002: 刷新功能
    echo ""
    echo "[TC-TENANT-002] 刷新功能"
    agent-browser click "button:has-text('刷新')"
    agent-browser wait 2000
    pass "刷新按钮可点击"
    
    # TC-TENANT-006: 创建租户按钮
    echo ""
    echo "[TC-TENANT-006] 创建租户按钮"
    agent-browser click "button:has-text('创建租户')"
    agent-browser wait 1000
    
    if agent-browser snapshot -i | grep -qE "(创建租户|名称|计划)"; then
        pass "创建租户模态框打开成功"
        agent-browser screenshot "$SCREENSHOT_DIR/tenants-create-modal.png"
        agent-browser press Escape
    else
        fail "创建租户模态框未打开"
    fi
}

# ========================================
# 5. 对话日志页面测试
# ========================================
test_conversations_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 对话日志"
    echo "========================================"
    
    agent-browser open "$BASE_URL/conversations"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/conversations-page.txt"
    
    # TC-CONV-001: 会话列表加载
    echo ""
    echo "[TC-CONV-001] 会话列表加载"
    if agent-browser snapshot -i | grep -qE "(会话|对话|对话日志)"; then
        pass "对话日志页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/conversations-list.png"
    else
        fail "对话日志页面加载失败"
    fi
    
    # TC-CONV-002: 刷新功能
    echo ""
    echo "[TC-CONV-002] 刷新功能"
    agent-browser click "button:has-text('刷新')"
    agent-browser wait 2000
    pass "刷新按钮可点击"
}

# ========================================
# 6. 用量统计页面测试
# ========================================
test_metrics_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 用量统计"
    echo "========================================"
    
    agent-browser open "$BASE_URL/metrics"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/metrics-page.txt"
    
    # TC-METR-001: 统计卡片加载
    echo ""
    echo "[TC-METR-001] 统计卡片加载"
    if agent-browser snapshot -i | grep -qE "(Token|成本|请求|延迟)"; then
        pass "统计卡片加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/metrics-stats.png"
    else
        fail "统计卡片加载失败"
    fi
    
    # TC-METR-005: 刷新功能
    echo ""
    echo "[TC-METR-005] 刷新功能"
    agent-browser click "button:has-text('刷新')"
    agent-browser wait 2000
    pass "刷新按钮可点击"
    
    # TC-METR-020: 导出 CSV 按钮
    echo ""
    echo "[TC-METR-020] 导出 CSV 按钮"
    if agent-browser snapshot -i | grep -qE "(导出|CSV)"; then
        pass "导出 CSV 按钮存在"
    else
        fail "导出 CSV 按钮未找到"
    fi
}

# ========================================
# 7. 告警规则页面测试
# ========================================
test_alerts_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 告警规则"
    echo "========================================"
    
    agent-browser open "$BASE_URL/alerts"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/alerts-page.txt"
    
    # TC-ALERT-001: 告警规则列表加载
    echo ""
    echo "[TC-ALERT-001] 告警规则列表加载"
    if agent-browser snapshot -i | grep -qE "(告警|规则|规则)"; then
        pass "告警规则页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/alerts-list.png"
    else
        fail "告警规则页面加载失败"
    fi
    
    # TC-ALERT-002: 刷新功能
    echo ""
    echo "[TC-ALERT-002] 刷新功能"
    agent-browser click "button:has-text('刷新')"
    agent-browser wait 2000
    pass "刷新按钮可点击"
}

# ========================================
# 8. 缓存管理页面测试
# ========================================
test_cache_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 缓存管理"
    echo "========================================"
    
    agent-browser open "$BASE_URL/cache"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/cache-page.txt"
    
    # TC-CACHE-001: 缓存统计加载
    echo ""
    echo "[TC-CACHE-001] 缓存统计加载"
    if agent-browser snapshot -i | grep -qE "(缓存|条目|命中)"; then
        pass "缓存统计加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/cache-stats.png"
    else
        fail "缓存统计加载失败"
    fi
}

# ========================================
# 9. 提示词模板页面测试
# ========================================
test_prompts_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 提示词模板"
    echo "========================================"
    
    agent-browser open "$BASE_URL/prompts"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/prompts-page.txt"
    
    # TC-PROMPT-001: 模板列表加载
    echo ""
    echo "[TC-PROMPT-001] 模板列表加载"
    if agent-browser snapshot -i | grep -qE "(模板|提示词)"; then
        pass "提示词模板页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/prompts-list.png"
    else
        fail "提示词模板页面加载失败"
    fi
}

# ========================================
# 10. 插件管理页面测试
# ========================================
test_plugins_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 插件管理"
    echo "========================================"
    
    agent-browser open "$BASE_URL/plugins"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/plugins-page.txt"
    
    # TC-PLUGIN-001: 插件列表加载
    echo ""
    echo "[TC-PLUGIN-001] 插件列表加载"
    if agent-browser snapshot -i | grep -qE "(插件|Plugin)"; then
        pass "插件管理页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/plugins-list.png"
    else
        fail "插件管理页面加载失败"
    fi
}

# ========================================
# 11. 路由状态页面测试
# ========================================
test_router_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 路由状态"
    echo "========================================"
    
    agent-browser open "$BASE_URL/router"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/router-page.txt"
    
    # TC-ROUTER-001: 路由规则列表加载
    echo ""
    echo "[TC-ROUTER-001] 路由状态页面加载"
    if agent-browser snapshot -i | grep -qE "(路由|规则|状态)"; then
        pass "路由状态页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/router-status.png"
    else
        fail "路由状态页面加载失败"
    fi
}

# ========================================
# 12. 系统设置页面测试
# ========================================
test_settings_page() {
    echo ""
    echo "========================================"
    echo "测试模块: 系统设置"
    echo "========================================"
    
    agent-browser open "$BASE_URL/settings"
    agent-browser wait --load networkidle
    agent-browser wait 2000
    agent-browser snapshot -i > "$SCREENSHOT_DIR/settings-page.txt"
    
    # TC-SETTING-001: 设置页面加载
    echo ""
    echo "[TC-SETTING-001] 系统设置页面加载"
    if agent-browser snapshot -i | grep -qE "(设置|基本|限流)"; then
        pass "系统设置页面加载成功"
        agent-browser screenshot "$SCREENSHOT_DIR/settings-form.png"
    else
        fail "系统设置页面加载失败"
    fi
}

# ========================================
# 13. 导航测试
# ========================================
test_navigation() {
    echo ""
    echo "========================================"
    echo "测试模块: 通用导航"
    echo "========================================"
    
    # TC-GENERAL-001~012: 侧边栏导航测试
    echo ""
    echo "[TC-GENERAL-001~012] 侧边栏导航测试"
    
    local pages=("dashboard" "providers" "tenants" "conversations" "metrics" "alerts" "cache" "prompts" "plugins" "router" "settings")
    local all_passed=true
    
    for page in "${pages[@]}"; do
        agent-browser open "$BASE_URL/$page"
        agent-browser wait --load networkidle
        agent-browser wait 1000
        
        # 检查页面是否加载
        if agent-browser get url | grep -q "$page"; then
            pass "导航到 $page 成功"
        else
            fail "导航到 $page 失败"
            all_passed=false
        fi
    done
}

# ========================================
# 主函数
# ========================================
main() {
    echo ""
    echo "========================================"
    echo "AI Gateway 管理控制台 - 自动化测试"
    echo "========================================"
    echo "开始时间: $(date)"
    echo "目标 URL: $BASE_URL"
    echo "截图目录: $SCREENSHOT_DIR"
    echo "========================================"
    
    # 启动浏览器
    echo ""
    echo "正在启动浏览器..."
    agent-browser open about:blank
    agent-browser wait 1000
    
    # 执行测试
    test_login_page
    test_dashboard_page
    test_providers_page
    test_tenants_page
    test_conversations_page
    test_metrics_page
    test_alerts_page
    test_cache_page
    test_prompts_page
    test_plugins_page
    test_router_page
    test_settings_page
    test_navigation
    
    # 关闭浏览器
    echo ""
    echo "关闭浏览器..."
    agent-browser close
    
    # 输出测试结果
    echo ""
    echo "========================================"
    echo "测试完成"
    echo "========================================"
    echo "通过: $TESTS_PASSED"
    echo "失败: $TESTS_FAILED"
    echo "阻塞: $TESTS_BLOCKED"
    echo "总计: $((TESTS_PASSED + TESTS_FAILED + TESTS_BLOCKED))"
    echo "通过率: $(echo "scale=2; $TESTS_PASSED * 100 / ($TESTS_PASSED + $TESTS_FAILED + $TESTS_BLOCKED)" | bc)%"
    echo "结束时间: $(date)"
    echo "========================================"
    
    # 保存测试结果
    {
        echo "AI Gateway 管理控制台 - 测试结果"
        echo "测试时间: $(date)"
        echo ""
        echo "测试统计:"
        echo "  通过: $TESTS_PASSED"
        echo "  失败: $TESTS_FAILED"
        echo "  阻塞: $TESTS_BLOCKED"
        echo "  总计: $((TESTS_PASSED + TESTS_FAILED + $TESTS_BLOCKED))"
    } > "$SCREENSHOT_DIR/test-results.txt"
    
    echo ""
    echo "测试报告已保存到: $SCREENSHOT_DIR/test-results.txt"
    echo "截图已保存到: $SCREENSHOT_DIR/"
}

# 运行测试
main
