import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,name:'Alice'|'Bob'){
 await page.goto('/');await page.getByRole('button',{name:new RegExp(name)}).click();
 await expect(page.getByRole('navigation',{name:'会话列表'})).toBeVisible();await page.getByRole('button',{name:'任务工作台',exact:true}).click();
 await expect(page.getByRole('navigation',{name:'任务列表'})).toBeVisible();
}
async function create(page:Page,title:string){
 await page.getByRole('button',{name:'新建任务',exact:true}).first().click();const dialog=page.getByRole('dialog');
 await dialog.getByLabel('任务标题',{exact:true}).fill(title);await dialog.getByLabel('目标',{exact:true}).fill('交付一份可复核的测试报告');
 await dialog.getByLabel(/^验收标准/).fill('包含实际结果与限制');await dialog.getByLabel(/^预算上限/).fill('0');
 await dialog.getByRole('button',{name:'创建任务',exact:true}).click();await expect(page.getByRole('heading',{name:title,level:1})).toBeVisible();
 await page.getByRole('button',{name:'开始任务',exact:true}).click();const start=page.getByRole('dialog');await start.getByLabel('操作理由',{exact:true}).fill('确认范围与验收条件');await start.getByRole('button',{name:'确认开始任务',exact:true}).click();
 await expect(page.getByRole('button',{name:'提交结果与证据',exact:true})).toBeVisible();
}
test('a human explicitly submits fixed evidence and separately accepts it before a task completes',async({page})=>{
 await login(page,'Alice');const title=`E2E 任务验收 ${Date.now()}`;await create(page,title);
 await page.getByRole('button',{name:'提交结果与证据',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('结果摘要',{exact:true}).fill('已完成可复核报告');await dialog.getByLabel(/^固定文字证据/).fill('复核结果：3 项符合。限制：仅限本次明确输入。');await dialog.getByRole('button',{name:'提交验收',exact:true}).click();
 await expect(page.getByLabel('任务详情').getByText('待验收',{exact:true})).toBeVisible();await page.getByRole('button',{name:'验收这次提交',exact:true}).click();
 const review=page.getByRole('dialog');await review.getByRole('combobox').selectOption('accept');await review.getByRole('textbox').fill('已核对固定版本和证据');await review.getByRole('checkbox').check();await review.getByRole('button',{name:'提交验收决定',exact:true}).click();
 await expect(page.getByLabel('任务详情').getByText('已完成',{exact:true})).toBeVisible();await expect(page.getByText('通过验收',{exact:true})).toBeVisible();
});
test('reading a handoff proposal does not change ownership; explicit acceptance changes both views',async({browser})=>{
 const a=await browser.newContext();const b=await browser.newContext();const alice=await a.newPage();const bob=await b.newPage();
 try{
  await login(alice,'Alice');await login(bob,'Bob');const title=`E2E 显式交接 ${Date.now()}`;await create(alice,title);
  await expect(bob.getByRole('navigation',{name:'任务列表'}).getByText(title,{exact:true})).toHaveCount(0);
  await alice.getByRole('button',{name:'发起协作提案',exact:true}).click();const dialog=alice.getByRole('dialog');await dialog.getByRole('combobox',{name:'收件人',exact:true}).selectOption({label:'Bob'});
  await dialog.getByLabel('对收件人披露的说明',{exact:true}).fill('仅披露此处所列目标、预算与验收约定');await dialog.getByLabel('已完成内容',{exact:true}).fill('已明确验收条件');await dialog.getByLabel('待完成内容',{exact:true}).fill('编写报告并提交验收');await dialog.getByRole('button',{name:'发送提案',exact:true}).click();
  await bob.getByRole('tab',{name:/协作请求/}).click();await bob.getByRole('navigation',{name:'协作请求列表'}).getByRole('button',{name:new RegExp(title)}).click();
  await expect(bob.getByRole('button',{name:'明确接受提案'})).toBeDisabled();await expect(alice.getByLabel('任务详情').getByRole('button',{name:'提交结果与证据',exact:true})).toBeVisible();
  await bob.getByRole('checkbox',{name:/我已阅读目标/}).check();await bob.getByRole('button',{name:'明确接受提案',exact:true}).click();await bob.getByRole('button',{name:'打开已获授权的任务',exact:true}).click();
  await expect(bob.getByLabel('任务详情').getByRole('heading',{name:title,level:1})).toBeVisible();await expect(bob.getByRole('button',{name:'提交结果与证据',exact:true})).toBeVisible();
  await expect(alice.getByLabel('任务详情').getByRole('button',{name:'发起协作提案',exact:true})).toHaveCount(0);
  await expect(alice.getByLabel('任务详情').getByText('负责人 · 执行与协调',{exact:true}).locator('..')).toContainText('Bob');
 }finally{await a.close();await b.close();}
});
