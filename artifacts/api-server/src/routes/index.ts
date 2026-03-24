import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sendRouter from "./send";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sendRouter);

export default router;
