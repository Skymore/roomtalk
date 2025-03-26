import { Room } from './types';

const SAVED_ROOMS_KEY = 'saved_rooms';

// Get saved rooms from localStorage
export const getSavedRooms = (): Room[] => {
  try {
    const savedRoomsJson = localStorage.getItem(SAVED_ROOMS_KEY);
    if (savedRoomsJson) {
      return JSON.parse(savedRoomsJson);
    }
  } catch (error) {
    console.error('Error reading saved rooms:', error);
  }
  return [];
};

// Save a room to localStorage
export const saveRoom = (room: Room): Room[] => {
  try {
    const savedRooms = getSavedRooms();
    // Check if room already exists in saved rooms
    const roomExists = savedRooms.some(savedRoom => savedRoom.id === room.id);
    
    if (!roomExists) {
      const updatedRooms = [...savedRooms, room];
      localStorage.setItem(SAVED_ROOMS_KEY, JSON.stringify(updatedRooms));
      return updatedRooms;
    }
    
    return savedRooms;
  } catch (error) {
    console.error('Error saving room:', error);
    return getSavedRooms();
  }
};

// Remove a room from localStorage
export const removeRoom = (roomId: string): Room[] => {
  try {
    const savedRooms = getSavedRooms();
    const updatedRooms = savedRooms.filter(room => room.id !== roomId);
    localStorage.setItem(SAVED_ROOMS_KEY, JSON.stringify(updatedRooms));
    return updatedRooms;
  } catch (error) {
    console.error('Error removing room:', error);
    return getSavedRooms();
  }
};

// Check if a room is saved
export const isRoomSaved = (roomId: string): boolean => {
  const savedRooms = getSavedRooms();
  return savedRooms.some(room => room.id === roomId);
}; 