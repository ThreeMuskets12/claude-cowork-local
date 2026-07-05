/**
 * GLM coding-plan model catalog advertised on the /zaisub route's /v1/models.
 *
 * These are the models available on the Z.ai GLM Coding Plan (from zcode-api's
 * provider/models.ts). Claude Desktop's model picker reads this list; the model
 * string the client then sends (e.g. "glm-5.2") is forwarded upstream as-is.
 */
export const ZAI_MODELS: Array<{ id: string; display_name: string; vision?: boolean }> = [
  { id: "glm-5.2", display_name: "GLM 5.2 (1M)" },
  { id: "glm-5.1", display_name: "GLM 5.1" },
  { id: "glm-5", display_name: "GLM 5" },
  { id: "glm-5-turbo", display_name: "GLM 5 Turbo" },
  { id: "glm-5v-turbo", display_name: "GLM 5V Turbo", vision: true },
  { id: "glm-4.7", display_name: "GLM 4.7" },
  { id: "glm-4.6", display_name: "GLM 4.6" },
  { id: "glm-4.6v", display_name: "GLM 4.6V", vision: true },
  { id: "glm-4.5-air", display_name: "GLM 4.5 Air" },
];

/** Default vision-capable model to escalate image requests to on /zaisub. */
export const ZAI_VISION_MODEL = "glm-4.6v";
