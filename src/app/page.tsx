import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 首页（占位）
 * - 旧的 spec 表单已清空、正在和用户重新设计交互形态
 * - 当前先给个稳定的占位卡片、避免 dev 起来时空白页让人误以为坏了
 */
const HomePage = () => {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <Card>
        <CardHeader>
          <CardTitle>页面待设计</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed">
          所有旧页面已清空、设置页正在重建中。
          <br />
          先去 <strong className="text-foreground">设置</strong> 配置 API key、之后再回来设计主流程。
        </CardContent>
      </Card>
    </div>
  );
};

export default HomePage;
