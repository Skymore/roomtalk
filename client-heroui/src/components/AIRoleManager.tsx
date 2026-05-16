import React, { useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  Input,
  Textarea,
  Select,
  SelectItem,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { AIRole, AIRoleColor, getAIRoleDisplayName, getAIRoleDisplayPrompt } from '../utils/aiRoles';

// AI角色管理组件接口
export interface AIRoleManagerProps {
  roles: AIRole[];
  selectedRoleId: string;
  onSelectRole: (roleId: string) => void;
  onAddRole: (role: AIRole) => void;
  onUpdateRole: (role: AIRole) => void;
  onDeleteRole: (roleId: string) => void;
}

export const AIRoleManager: React.FC<AIRoleManagerProps> = ({
  roles,
  selectedRoleId,
  onSelectRole,
  onAddRole,
  onUpdateRole,
  onDeleteRole
}) => {
  const { t } = useTranslation();
  const defaultSystemPrompt = t('defaultSystemPrompt');
  const [editingRole, setEditingRole] = useState<AIRole | null>(null);
  const [newRole, setNewRole] = useState<Partial<AIRole>>({
    name: '',
    systemPrompt: defaultSystemPrompt,
    color: 'primary',
    icon: 'lucide:bot'
  });
  // 添加删除确认和创建表单状态
  const [roleToDelete, setRoleToDelete] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
  const { isOpen: isDeleteConfirmOpen, onOpen: onDeleteConfirmOpen, onClose: onDeleteConfirmClose } = useDisclosure();

  // 开始删除角色过程
  const handleStartDelete = (roleId: string) => {
    setRoleToDelete(roleId);
    onDeleteConfirmOpen();
  };

  // 确认删除角色
  const handleConfirmDelete = () => {
    if (roleToDelete) {
      onDeleteRole(roleToDelete);
      setRoleToDelete(null);
      onDeleteConfirmClose();
    }
  };

  // 取消删除
  const handleCancelDelete = () => {
    setRoleToDelete(null);
    onDeleteConfirmClose();
  };

  // 开始编辑角色
  const handleEditRole = (role: AIRole) => {
    setEditingRole({...role});
  };

  // 保存角色编辑
  const handleSaveEdit = () => {
    if (editingRole) {
      onUpdateRole(editingRole);
      setEditingRole(null);
    }
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingRole(null);
  };

  // 创建新角色
  const handleCreateRole = () => {
    if (newRole.name && newRole.systemPrompt) {
      const role: AIRole = {
        id: `role_${Date.now()}`,
        name: newRole.name,
        systemPrompt: newRole.systemPrompt || defaultSystemPrompt,
        color: newRole.color as AIRoleColor || 'primary',
        icon: newRole.icon || 'lucide:bot'
      };

      onAddRole(role);

      // 重置新角色表单
      setNewRole({
        name: '',
        systemPrompt: defaultSystemPrompt,
        color: 'primary',
        icon: 'lucide:bot'
      });
    }
  };

  const colorOptions = [
    { value: 'primary', labelKey: 'colorPrimary' },
    { value: 'secondary', labelKey: 'colorSecondary' },
    { value: 'success', labelKey: 'colorSuccess' },
    { value: 'warning', labelKey: 'colorWarning' },
    { value: 'danger', labelKey: 'colorDanger' }
  ];

  const iconOptions = [
    { value: 'lucide:bot', labelKey: 'iconBot' },
    { value: 'lucide:code', labelKey: 'iconCode' },
    { value: 'lucide:brain', labelKey: 'iconBrain' },
    { value: 'lucide:pen', labelKey: 'iconCreative' },
    { value: 'lucide:book', labelKey: 'iconBook' },
    { value: 'lucide:rocket', labelKey: 'iconRocket' }
  ];

  return (
    <div className="min-w-0 space-y-4 sm:space-y-6">
      {/* 角色列表 */}
      <div className="space-y-3">
        <h3 className="font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">{t('existingRoles')}</h3>
        <div className="space-y-2">
          {roles.map(role => (
            <Card key={role.id} className={`min-w-0 border bg-[#faf9f5] p-3 dark:bg-[#1d1d1b] ${selectedRoleId === role.id ? 'border-[#c96442] shadow-[0_0_0_1px_#c96442]' : 'border-[#dedbd0] dark:border-[#30302e]'}`}>
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar
                    icon={<Icon icon={role.icon} />}
                    color={role.color}
                    size="sm"
                    className="flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[#141413] dark:text-[#faf9f5]">{getAIRoleDisplayName(role, t)}</p>
                    <p className="truncate text-xs text-[#5e5d59] dark:text-[#b0aea5]">{getAIRoleDisplayPrompt(role, t)}</p>
                  </div>
                </div>
                <div className="flex flex-shrink-0 gap-1">
                  <Button isIconOnly size="sm" variant="light" className="h-8 w-8 min-w-8" onPress={() => onSelectRole(role.id)}>
                    <Icon icon="lucide:check" />
                  </Button>
                  <Button isIconOnly size="sm" variant="light" className="h-8 w-8 min-w-8" onPress={() => handleEditRole(role)}>
                    <Icon icon="lucide:edit" />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    className="h-8 w-8 min-w-8"
                    isDisabled={roles.length <= 1}
                    onPress={() => handleStartDelete(role.id)}
                  >
                    <Icon icon="lucide:trash" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* 角色编辑表单 */}
      {editingRole && (
        <Card className="space-y-4 border border-[#dedbd0] bg-[#faf9f5] p-4 dark:border-[#30302e] dark:bg-[#1d1d1b]">
          <h3 className="font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">{t('editRole')}</h3>
          <Input
            label={t('roleName')}
            value={editingRole.name}
            onChange={(e) => setEditingRole({...editingRole, name: e.target.value})}
          />
          <Textarea
            label={t('systemPrompt')}
            value={editingRole.systemPrompt}
            onChange={(e) => setEditingRole({...editingRole, systemPrompt: e.target.value})}
            minRows={3}
            maxRows={5}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Select
              label={t('roleColor')}
              selectedKeys={[editingRole.color]}
              onSelectionChange={(keys) => {
                const selectedKey = Array.from(keys)[0]?.toString();
                if (selectedKey) setEditingRole({...editingRole, color: selectedKey as any});
              }}
            >
              {colorOptions.map((option) => (
                <SelectItem key={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </Select>
            <Select
              label={t('roleIcon')}
              selectedKeys={[editingRole.icon]}
              onSelectionChange={(keys) => {
                const selectedKey = Array.from(keys)[0]?.toString();
                if (selectedKey) setEditingRole({...editingRole, icon: selectedKey});
              }}
              startContent={<Icon icon={editingRole.icon} />}
            >
              {iconOptions.map((option) => (
                <SelectItem key={option.value} startContent={<Icon icon={option.value} />}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="flex justify-end space-x-2">
            <Button variant="light" onPress={handleCancelEdit}>{t('cancel')}</Button>
            <Button color="secondary" className="bg-[#c96442] text-[#faf9f5]" onPress={handleSaveEdit}>{t('save')}</Button>
          </div>
        </Card>
      )}

      {/* 新角色创建按钮和表单 */}
      {!showCreateForm ? (
        <div className="flex justify-center">
          <Button
            color="secondary"
            startContent={<Icon icon="lucide:plus" />}
            onPress={() => setShowCreateForm(true)}
            className="w-full bg-[#c96442] text-[#faf9f5] sm:w-auto"
          >
            {t('createNewRole')}
          </Button>
        </div>
      ) : (
        <Card className="space-y-4 border border-[#dedbd0] bg-[#faf9f5] p-4 dark:border-[#30302e] dark:bg-[#1d1d1b]">
          <div className="flex justify-between items-center">
            <h3 className="font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">{t('createNewRole')}</h3>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              onPress={() => setShowCreateForm(false)}
            >
              <Icon icon="lucide:x" />
            </Button>
          </div>
          <Input
            label={t('roleName')}
            placeholder={t('enterRoleName')}
            value={newRole.name}
            onChange={(e) => setNewRole({...newRole, name: e.target.value})}
          />
          <Textarea
            label={t('systemPrompt')}
            placeholder={t('describeAIRole')}
            value={newRole.systemPrompt}
            onChange={(e) => setNewRole({...newRole, systemPrompt: e.target.value})}
            minRows={3}
            maxRows={5}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Select
              label={t('roleColor')}
              selectedKeys={[newRole.color as string]}
              onSelectionChange={(keys) => {
                const selectedKey = Array.from(keys)[0]?.toString();
                if (selectedKey) setNewRole({...newRole, color: selectedKey as any});
              }}
            >
              {colorOptions.map((option) => (
                <SelectItem key={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </Select>
            <Select
              label={t('roleIcon')}
              selectedKeys={[newRole.icon as string]}
              onSelectionChange={(keys) => {
                const selectedKey = Array.from(keys)[0]?.toString();
                if (selectedKey) setNewRole({...newRole, icon: selectedKey});
              }}
              startContent={newRole.icon ? <Icon icon={newRole.icon as string} /> : undefined}
            >
              {iconOptions.map((option) => (
                <SelectItem key={option.value} startContent={<Icon icon={option.value} />}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="flex justify-end">
            <Button
              color="secondary"
              className="bg-[#c96442] text-[#faf9f5]"
              onPress={() => {
                handleCreateRole();
                setShowCreateForm(false);
              }}
              isDisabled={!newRole.name || !newRole.systemPrompt}
            >
              {t('createRole')}
            </Button>
          </div>
        </Card>
      )}

      {/* 删除确认对话框 */}
      <Modal isOpen={isDeleteConfirmOpen} onClose={handleCancelDelete} size="sm">
        <ModalContent>
          <ModalHeader>{t('confirmDeleteRole')}</ModalHeader>
          <ModalBody>
            <p>{t('confirmDeleteRoleDescription')}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleCancelDelete}>
              {t('cancel')}
            </Button>
            <Button color="danger" onPress={handleConfirmDelete}>
              {t('delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};
