import { createRouter, createWebHistory } from 'vue-router'
import { authStore } from '../stores/auth'
import LoginView from '../views/LoginView.vue'
import ChatView from '../views/ChatView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
    },
    {
      path: '/',
      name: 'chat',
      component: ChatView,
      meta: { requiresAuth: true },
    },
    // 其餘路由重新導向至首頁
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

// 路由守衛：未登入時跳轉至登入頁
router.beforeEach((to) => {
  if (to.meta.requiresAuth && !authStore.isLoggedIn.value) {
    return { name: 'login' }
  }
  // 已登入時不允許進入登入頁
  if (to.name === 'login' && authStore.isLoggedIn.value) {
    return { name: 'chat' }
  }
})

export default router
