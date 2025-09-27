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

// AI角色类型定义
export interface AIRole {
  id: string;
  name: string;
  systemPrompt: string;
  color: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  icon: string;
}

// 定义默认AI角色
export const defaultAIRoles: AIRole[] = [
  {
    id: 'default',
    name: 'Assistant',
    systemPrompt: 'You are a helpful, creative, friendly assistant. Respond concisely and clearly.',
    color: 'secondary',
    icon: 'lucide:bot'
  },
  {
    id: 'coder',
    name: 'Code Expert',
    systemPrompt: 'You are a programming expert who provides detailed technical solutions and code examples. Focus on best practices and performance.',
    color: 'primary',
    icon: 'lucide:code'
  },
  {
    id: 'creative',
    name: 'Creative Writer',
    systemPrompt: 'You are a creative writing assistant with a vivid imagination. Help users with storytelling and creative content.',
    color: 'success',
    icon: 'lucide:pen'
  }
];

// 获取本地存储的AI角色，如果不存在则使用默认值
export const getSavedAIRoles = (): AIRole[] => {
  try {
    const saved = localStorage.getItem('aiRoles');
    return saved ? JSON.parse(saved) : defaultAIRoles;
  } catch (e) {
    console.error('Error loading AI roles:', e);
    return defaultAIRoles;
  }
};

// 保存AI角色到本地存储
export const saveAIRoles = (roles: AIRole[]) => {
  try {
    localStorage.setItem('aiRoles', JSON.stringify(roles));
  } catch (e) {
    console.error('Error saving AI roles:', e);
  }
};

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
  const [editingRole, setEditingRole] = useState<AIRole | null>(null);
  const [newRole, setNewRole] = useState<Partial<AIRole>>({
    name: '',
    systemPrompt: 'You are a helpful assistant.',
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
        systemPrompt: newRole.systemPrompt || 'You are a helpful assistant.',
        color: newRole.color as 'primary' | 'secondary' | 'success' | 'warning' | 'danger' || 'primary',
        icon: newRole.icon || 'lucide:bot'
      };
      
      onAddRole(role);
      
      // 重置新角色表单
      setNewRole({
        name: '',
        systemPrompt: 'You are a helpful assistant.',
        color: 'primary',
        icon: 'lucide:bot'
      });
    }
  };
  
  const colorOptions = [
    { value: 'primary', label: 'Primary' },
    { value: 'secondary', label: 'Secondary' },
    { value: 'success', label: 'Success' },
    { value: 'warning', label: 'Warning' },
    { value: 'danger', label: 'Danger' }
  ];
  
  const iconOptions = [
    { value: 'lucide:bot', label: 'Bot' },
    { value: 'lucide:code', label: 'Code' },
    { value: 'lucide:brain', label: 'Brain' },
    { value: 'lucide:pen', label: 'Creative' },
    { value: 'lucide:book', label: 'Book' },
    { value: 'lucide:rocket', label: 'Rocket' }
  ];
  
  return (
    <div className="space-y-6">
      {/* 角色列表 */}
      <div className="space-y-3">
        <h3 className="text-lg font-medium">{t('existingRoles')}</h3>
        <div className="space-y-2">
          {roles.map(role => (
            <Card key={role.id} className={`p-3 ${selectedRoleId === role.id ? 'border-2 border-' + role.color : ''}`}>
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <Avatar
                    icon={<Icon icon={role.icon} />}
                    color={role.color}
                    size="sm"
                  />
                  <div>
                    <p className="font-medium">{role.name}</p>
                    <p className="text-xs text-default-500 truncate max-w-md">{role.systemPrompt}</p>
                  </div>
                </div>
                <div className="flex space-x-1">
                  <Button isIconOnly size="sm" variant="light" onPress={() => onSelectRole(role.id)}>
                    <Icon icon="lucide:check" />
                  </Button>
                  <Button isIconOnly size="sm" variant="light" onPress={() => handleEditRole(role)}>
                    <Icon icon="lucide:edit" />
                  </Button>
                  <Button 
                    isIconOnly 
                    size="sm" 
                    variant="light" 
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
        <Card className="p-4 space-y-4">
          <h3 className="text-lg font-medium">{t('editRole')}</h3>
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
          <div className="grid grid-cols-2 gap-2">
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
                  {option.label}
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
                  {option.label}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="flex justify-end space-x-2">
            <Button variant="light" onPress={handleCancelEdit}>{t('cancel')}</Button>
            <Button color="primary" onPress={handleSaveEdit}>{t('save')}</Button>
          </div>
        </Card>
      )}
      
      {/* 新角色创建按钮和表单 */}
      {!showCreateForm ? (
        <div className="flex justify-center">
          <Button
            color="primary"
            startContent={<Icon icon="lucide:plus" />}
            onPress={() => setShowCreateForm(true)}
          >
            {t('createNewRole')}
          </Button>
        </div>
      ) : (
        <Card className="p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-medium">{t('createNewRole')}</h3>
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
            placeholder={t('enterRoomName') || "Enter role name"}
            value={newRole.name}
            onChange={(e) => setNewRole({...newRole, name: e.target.value})}
          />
          <Textarea
            label={t('systemPrompt')}
            placeholder={t('describeRoom') || "Describe how the AI should behave"}
            value={newRole.systemPrompt}
            onChange={(e) => setNewRole({...newRole, systemPrompt: e.target.value})}
            minRows={3}
            maxRows={5}
          />
          <div className="grid grid-cols-2 gap-2">
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
                  {option.label}
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
                  {option.label}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="flex justify-end">
            <Button 
              color="primary" 
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