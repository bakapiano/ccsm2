# Space Template

Space Template 是创建新 Space 的可复用配方。首版使用 Template 创建新的磁盘目录、clone 配置的 repositories，并让一个普通 Space 绑定该目录。

```text
Space Template
├─ name
├─ base directory
└─ repositories
   ├─ display name
   ├─ clone URL
   └─ target directory

        instantiate
            ↓

new root folder → ordinary Space
```

## 概念边界

- Space Template 保存创建输入。
- Space 保存创建完成后的工作现场，包括固定 root、布局、Tabs 和 CLI Sessions。
- Template 实例化产生一个新的 root folder和一个普通Space。
- 创建完成后，Space与Template独立演进。
- 所有Template创建结果使用现有Space和SpaceRoot模型。
- Space可以记录`createdFromTemplateId`作为来源信息。

Template实例化流程承接v1 workspace的目录创建和repository clone行为。

## Template 内容

首版Template包含：

```text
SpaceTemplate
├─ id
├─ name
├─ baseDirectory
└─ repositories[]
   ├─ name
   ├─ cloneUrl
   └─ targetDirectory
```

- `name`用于New Space中的Template选择。
- `baseDirectory`是新root folder的父目录。
- `repositories`声明需要clone到新root中的repositories。
- `targetDirectory`是相对于新root的单个安全路径段。
- `targetDirectory`默认使用repository name，并支持用户指定名称。
- Repository credentials继续由用户现有Git工具链管理。

首版范围是创建root folder和clone repositories。

## New Space体验

New Space提供两种入口：

```text
Existing Folder → 选择已有root → 创建Space
From Template   → 创建新root + clone → 创建Space
```

From Template流程要求用户选择Template并确认Space名称。CCSM根据Space名称在Template的`baseDirectory`下生成root folder名称，并在确认页面展示最终绝对路径与待clone列表。

CCSM为每次From Template操作分配唯一的新目录。Existing Folder入口承载已有目录的Space创建流程。

## 创建流程

```text
validate template and destination
→ create root folder
→ clone repositories with progress
→ create ordinary Space bound to the root
→ activate Space and run Git discovery
```

- 创建操作按Template中的repository顺序报告进度。
- clone目标已经存在时创建失败，并显示冲突路径。
- clone全部成功后才提交Space和SpaceRoot记录。
- Space创建成功后遵循现有固定root、恢复、切换和删除规则。
- Git discovery从最终root发现root及直属子目录中的repositories。

## 失败与重试

- validation通过后开始创建目录。
- mkdir和clone全部完成后创建Space记录。
- 失败界面保留错误、root路径和每个repository结果，并提供Retry。
- Retry复用本次创建目录；已成功且remote匹配的clone标记为完成，其余repositories继续执行。
- 用户确认放弃创建后可以清理本次创建目录。
- 应用重启后从已提交Space记录恢复Space列表。

技术规格定义创建中断任务的恢复和持久化方式，并维持“完成clone后创建Space”的产品语义。

## 生命周期

- 删除Template保留由它创建的Spaces和磁盘目录。
- 删除Space继续保留其磁盘root folder，与Existing Folder创建的Space行为一致。
- 修改Template成为之后创建使用的新配方。
- 同一Template可以创建任意多个Spaces，每次使用新的root folder。
- 用户之后可以从同一个root额外创建其他Spaces，并为每个Space保存独立layout和Tabs。

## 验收条件

- 用户可以保存包含base directory和多个repositories的Template。
- 用户可以从Template创建新目录、clone repositories并进入新Space。
- clone期间可以看到当前repository、进度和错误。
- Space列表在全部clone完成后增加新Space。
- 再次使用同一Template会创建新的唯一root。
- 已有Space保持创建完成时的独立状态。
- 删除Template或Space保留磁盘目录。
