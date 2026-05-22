FROM node:20-alpine

WORKDIR /app

# 安装依赖（跳过 prepare 脚本，避免 husky 在容器内执行失败）
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# 复制源码
COPY dist/ ./dist/
COPY conf/ ./conf/

# 环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000

# 启动
CMD ["node", "dist/index.js"]