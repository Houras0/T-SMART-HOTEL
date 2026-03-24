import { Router, type IRouter } from "express";
import sendRouter from "./send";

const router: IRouter = Router();

router.use(sendRouter);

export default router;
