SERVER_URL=${1:-"http://localhost:3002"}
ACCESS_TOKEN=${2:-"your_access_token"}
TEST_FILE="test-conflict-$(date +%s).md"
echo "🧪 开始冲突检测测试..."
echo "服务器: $SERVER_URL"
echo "测试文件: $TEST_FILE"
echo ""
echo "📤 步骤 1: 上传初始版本"
curl -X POST "$SERVER_URL/upload" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$ACCESS_TOKEN\",
    \"deviceId\": \"device-A\",
    \"files\": [{
      \"filePath\": \"$TEST_FILE\",
      \"content\": \"初始内容 - 版本 1\",
      \"operation\": \"create\",
      \"hash\": \"hash_v1_aaaaaaaaaaaaaaaaaaaaaaaaa\",
      \"mtime\": $(date +%s000),
      \"baseHash\": null
    }]
  }"
echo -e "\n"
sleep 2
echo "📤 步骤 2: 设备 B 修改并上传（基于版本 1）"
curl -X POST "$SERVER_URL/upload" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$ACCESS_TOKEN\",
    \"deviceId\": \"device-B\",
    \"files\": [{
      \"filePath\": \"$TEST_FILE\",
      \"content\": \"设备 B 的修改\",
      \"operation\": \"update\",
      \"hash\": \"hash_v2_bbbbbbbbbbbbbbbbbbbbbbbbb\",
      \"mtime\": $(date +%s000),
      \"baseHash\": \"hash_v1_aaaaaaaaaaaaaaaaaaaaaaaaa\"
    }]
  }"
echo -e "\n"
sleep 2
echo "📤 步骤 3: 设备 A 修改并上传（基于版本 1 - 应该触发冲突）"
curl -X POST "$SERVER_URL/upload" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$ACCESS_TOKEN\",
    \"deviceId\": \"device-A\",
    \"files\": [{
      \"filePath\": \"$TEST_FILE\",
      \"content\": \"设备 A 的修改（冲突）\",
      \"operation\": \"update\",
      \"hash\": \"hash_v3_ccccccccccccccccccccccccc\",
      \"mtime\": $(date +%s000),
      \"baseHash\": \"hash_v1_aaaaaaaaaaaaaaaaaaaaaaaaa\"
    }]
  }"
echo -e "\n"
sleep 2
echo "📋 步骤 4: 查询冲突列表"
curl -X GET "$SERVER_URL/conflicts?token=$ACCESS_TOKEN"
echo -e "\n"
echo ""
echo "✅ 测试完成！"
echo ""
echo "预期结果："
echo "  - 步骤 1: 成功上传，无冲突"
echo "  - 步骤 2: 成功上传，无冲突（baseHash 匹配）"
echo "  - 步骤 3: 检测到冲突，生成副本（baseHash = v1，但服务器 = v2）"
echo "  - 步骤 4: 冲突列表中应该有 1 条记录"
echo ""
echo "💡 检查服务器日志查看详细信息："
echo "   pm2 logs clawmd-hub-server"
