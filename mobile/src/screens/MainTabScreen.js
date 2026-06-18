import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import FlightScreen from './FlightScreen';
import PositionScreen from './PositionScreen';
import AnnouncementScreen from './AnnouncementScreen';
import { Plane, Users, Megaphone } from 'lucide-react-native';

const Tab = createBottomTabNavigator();

export default function MainTabScreen() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          if (route.name === 'Flights') {
            return <Plane size={size} color={color} />;
          } else if (route.name === 'Positions') {
            return <Users size={size} color={color} />;
          } else if (route.name === 'Announcements') {
            return <Megaphone size={size} color={color} />;
          }
        },
        tabBarActiveTintColor: '#38bdf8',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: {
          backgroundColor: '#0f172a',
          borderTopColor: '#1e293b',
          height: 60,
          paddingBottom: 10,
        },
        headerStyle: {
          backgroundColor: '#0f172a',
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 1,
          borderBottomColor: '#1e293b',
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      })}
    >
      <Tab.Screen name="Flights" component={FlightScreen} />
      <Tab.Screen name="Positions" component={PositionScreen} />
      <Tab.Screen name="Announcements" component={AnnouncementScreen} />
    </Tab.Navigator>
  );
}
