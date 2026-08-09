const policyPattern = /请假|休假|考勤|打卡|迟到|早退|加班|几点上班|几点下班|上班时间|下班时间|工作时间|办公时间|上下班|工时|午休|作息|报销|社保|公积金|试用期|福利|保密|信息安全|劳动合同|合同争议|劳动争议|离职|辞职|辞退|解雇|裁员|仲裁|竞业|补偿|赔偿/;
const trainingPattern = /培训|课程|学习|学什么/;
const contactPattern = /联系|找谁|是谁|谁负责|负责|领导|上级|老板|汇报|hr|hrbp|it|工位|门禁|电脑|账号/i;
const cozePattern = /coze|扣子|工作流/i;
const materialPattern = /入职.*(?:材料|资料)|报到.*(?:材料|资料)|报道.*(?:材料|资料)|入职资料|报到资料|报道资料|携带什么|带什么材料|带啥资料|身份证.*(?:原件|复印件|提交|携带)|学历证明|离职证明|银行卡(?:号|信息|开户行)|证件照|体检报告/;
const taskPattern = /第一天|入职当天|入职.*(?:任务|待办|要做|进度|优先事项)|任务|待办|要做|需要做|下一步|入职进度|优先事项|准备什么|三十天|30天|电脑|账号|门禁|工位/;
const processPattern = /流程|怎么办理|如何办理|办理|怎么领取|领取|门禁|账号|请假|报销|社保|公积金/;

export const asksManager = (question = "") => /直属领导(?:是)?谁|谁是(?:我|我的)?直属领导|领导是谁|上级是谁|老板是谁|汇报给谁|汇报对象|部门负责人是谁/.test(question);
export const asksHrPartner = (question = "") => /hr\s*(对接人|是谁)|hrbp\s*(?:是)?谁|人力.*(对接人|是谁)|对接.*hr/i.test(question);
export const asksOnboardingMaterials = (question = "") => materialPattern.test(question);
export const asksThirdPartyCompensation = (question = "") => /直属领导|领导|上级|同事|别人|他人|其他人/.test(question) && /工资|薪资|薪酬|奖金|提成|收入/.test(question);

export function detectQuestionContext(question = "") {
  const q = question.toLowerCase();
  const rejectsTask = /(?:不要|不需要|别)(?:给我|回答|生成|提供|讲)?[^。！？]*(?:入职)?任务|不需要入职任务清单/.test(q);
  const rejectsPolicy = /(?:不要|不需要|别)(?:给我|回答|生成|提供|讲)?[^。！？]*(?:公司)?制度/.test(q);
  return {
    always: true,
    policy: policyPattern.test(q),
    training: trainingPattern.test(q),
    contact: contactPattern.test(q),
    coze: cozePattern.test(q),
    materials: materialPattern.test(q),
    task: taskPattern.test(q) && !rejectsTask,
    process: processPattern.test(q),
    rejects_policy: rejectsPolicy,
  };
}

export function topicForQuestion(question = "") {
  if (asksManager(question)) return "直属领导";
  if (asksHrPartner(question)) return "HR 对接人";
  if (asksOnboardingMaterials(question)) return "入职报到材料";
  if (/几点上班|几点下班|上班时间|下班时间|工作时间|办公时间|上下班|工时|午休|作息/.test(question)) return "工作时间";
  if (/请假|休假/.test(question)) return "请假";
  if (/考勤|打卡|迟到|早退|加班/.test(question)) return "考勤";
  if (/社保|公积金/.test(question)) return "社保公积金";
  if (/培训|课程|学习/.test(question)) return "培训";
  if (/电脑|设备/.test(question)) return "设备领取";
  if (/账号/.test(question)) return "账号开通";
  if (taskPattern.test(question)) return "入职任务";
  return "未识别问题";
}

export function contactRolesForQuestion(question = "") {
  if (asksManager(question)) return ["部门负责人"];
  if (asksHrPartner(question)) return ["HR"];
  if (/电脑|账号/.test(question)) return ["IT"];
  if (/门禁|工位/.test(question)) return ["行政"];
  if (/培训/.test(question)) return ["培训"];
  if (/负责人|联系|找谁/.test(question)) return ["HR", "部门负责人"];
  return [];
}

export const isPolicyQuestion = (question = "") => policyPattern.test(question.toLowerCase());
export function isSensitiveQuestion(question = "") {
  if (/工资|薪资|薪酬|奖金|提成|收入|福利|补贴|社保|公积金|劳动合同|合同争议|劳动争议|离职|辞职|辞退|解雇|裁员|仲裁|诉讼|竞业|补偿|赔偿|绩效|隐私|银行卡/.test(question)) return true;
  if (/绕过.*(?:审批|权限)|所有员工.*(?:状态|联系方式|档案)/i.test(question)) return true;
  if (/(?:输出|告诉|发给|发在|提供|泄露|是多少|完整).{0,12}(?:api\s*key|token|密码|验证码)|(?:api\s*key|token|密码|验证码).{0,12}(?:输出|告诉|发给|发在|提供|泄露|是多少|完整)/i.test(question)) return true;
  return /身份证(?:号|号码|照片|扫描|上传|发送|发给|泄露|被盗用|可以给)/.test(question);
}
