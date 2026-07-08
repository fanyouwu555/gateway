/**
 * Admin API 路由聚合器
 * 挂载所有 admin 子路由，统一应用 requireAdmin 中间件
 */
import { Hono } from 'hono';
import { requireAdmin } from '../../middleware/auth';
import usageRouter from './usage';
import tenantRouter from './tenant';
import configRouter from './config';
import promptRouter from './prompt';
import pluginRouter from './plugin';
import alertRouter from './alert';
import systemRouter from './system';
import tenantTemplateRouter from './tenant-template';

const adminRouter = new Hono();
adminRouter.use('*', requireAdmin);

// 挂载各领域的 admin 子路由
adminRouter.route('/', usageRouter);
adminRouter.route('/', tenantRouter);
adminRouter.route('/', tenantTemplateRouter);
adminRouter.route('/', configRouter);
adminRouter.route('/', promptRouter);
adminRouter.route('/', pluginRouter);
adminRouter.route('/', alertRouter);
adminRouter.route('/', systemRouter);

export default adminRouter;
