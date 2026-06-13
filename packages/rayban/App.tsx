import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { HomeScreen } from './src/screens/HomeScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LlmScreen } from './src/screens/LlmScreen';
import { bootstrap } from './src/runtime/bootstrap';

const Tab = createBottomTabNavigator();

export default function App() {
  useEffect(() => {
    void bootstrap();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: '#000' },
            headerTintColor: '#fff',
            tabBarStyle: { backgroundColor: '#111', borderTopColor: '#222' },
            tabBarActiveTintColor: '#4caf50',
            tabBarInactiveTintColor: '#555',
          }}
        >
          <Tab.Screen
            name="Home"
            component={HomeScreen}
            options={{
              tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                <Ionicons name="home" size={size} color={color} />
              ),
            }}
          />
          <Tab.Screen
            name="Conversation"
            component={ConversationScreen}
            options={{
              tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                <Ionicons name="list" size={size} color={color} />
              ),
            }}
          />
          <Tab.Screen
            name="LLM"
            component={LlmScreen}
            options={{
              tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                <Ionicons name="cloud" size={size} color={color} />
              ),
            }}
          />
          <Tab.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              tabBarIcon: ({ color, size }: { color: string; size: number }) => (
                <Ionicons name="settings" size={size} color={color} />
              ),
            }}
          />
        </Tab.Navigator>
      </NavigationContainer>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
